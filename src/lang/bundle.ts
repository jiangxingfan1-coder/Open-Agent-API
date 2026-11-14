import path from 'node:path';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import {
  agentSchema,
  bundleSchema,
  type AgentBundle,
  type AgentDefinition,
  bindingSchema,
} from '../core/contracts.js';
import { canonical, Fault, readBounded, relativeName, sha, writePrivate } from '../core/util.js';
import { JsonSchemas } from '../core/schemas.js';
import { compileOaaLang } from './lang.js';
import { validateWorkflows } from './graph.js';
import { builtin, builtinNames, type BuiltinToolName } from '../core/builtins.js';

export { builtin } from '../core/builtins.js';

const schemas = new JsonSchemas();

const forbiddenName =
  /(^|\/)(?:\.env(?:\..*)?|\.git|node_modules|auth\.json|credentials[^/]*|[^/]*\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519)(\/|$)/i;
const secretPattern =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-|oaa-)?[A-Za-z0-9_-]{24,}|oaa_[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{16})\b/;
export function assertPublishableMetadata(value: unknown): void {
  const blocked = () =>
    new Fault(
      'secret_in_bundle',
      'Possible credential in public capability metadata; publication refused.',
    );
  const credential =
    /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)$/i;
  const visit = (node: unknown, credentialField = false, depth = 0): void => {
    if (depth > 80)
      throw new Fault(
        'metadata_too_deep',
        'Capability metadata exceeds the supported nesting depth.',
      );
    if (typeof node === 'string') {
      if (secretPattern.test(node) || /\bBearer\s+[A-Za-z0-9._-]{16,}/i.test(node)) throw blocked();
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, credentialField, depth + 1);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) {
      if (
        (credential.test(key) && typeof item === 'string' && item.length) ||
        (credentialField &&
          ['default', 'const', 'example', 'examples', 'enum'].includes(key) &&
          item !== undefined &&
          item !== null &&
          item !== '' &&
          (!Array.isArray(item) || item.some((entry) => entry !== null && entry !== '')))
      )
        throw blocked();
      visit(item, credentialField || credential.test(key), depth + 1);
    }
  };
  visit(value);
}
export function validateBundle(raw: unknown): AgentBundle {
  const bundle = bundleSchema.parse(raw);
  assertPublishableMetadata(bundle.agent);
  if (Buffer.byteLength(JSON.stringify(bundle)) > 12 * 1024 * 1024)
    throw new Fault('bundle_too_large', 'Bundle exceeds 12 MiB.', 413);
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of bundle.files) {
    relativeName(file.path);
    if (forbiddenName.test(file.path) || paths.has(file.path))
      throw new Fault('unsafe_bundle', `Forbidden or duplicate bundle path: ${file.path}`);
    paths.add(file.path);
    const contents = Buffer.from(file.content, 'base64');
    if (contents.toString('base64') !== file.content || sha(contents) !== file.sha256)
      throw new Fault('bundle_integrity', `Invalid content digest: ${file.path}`);
    if (secretPattern.test(contents.toString('utf8')))
      throw new Fault('secret_in_bundle', `Possible secret in ${file.path}; publication refused.`);
    bytes += contents.byteLength;
  }
  if (bytes > 8 * 1024 * 1024)
    throw new Fault('bundle_too_large', 'Decoded bundle exceeds 8 MiB.', 413);
  for (const s of bundle.agent.skills)
    if (!paths.has(s.path)) throw new Fault('missing_skill', `Missing skill: ${s.path}`);
  for (const t of bundle.agent.tools)
    if (t.handler.kind === 'script' && !paths.has(t.handler.path))
      throw new Fault('missing_script', `Missing script: ${t.handler.path}`);
  const { digest, ...content } = bundle;
  if (sha(canonical(content)) !== digest)
    throw new Fault('bundle_integrity', 'Bundle manifest digest does not match.');
  for (const tool of bundle.agent.tools) schemas.compile(tool.capability.inputSchema);
  if (bundle.agent.workflows?.length) {
    validateWorkflows(bundle.agent, { schemas });
  }
  if (bundle.agent.outputSchema) schemas.compile(bundle.agent.outputSchema);
  return bundle;
}
export function makeBundle(agent: AgentDefinition, files: AgentBundle['files'] = []): AgentBundle {
  const content = {
    format: 'oaa.bundle.v1' as const,
    agent: agentSchema.parse(agent),
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
  };
  return validateBundle({ ...content, digest: sha(canonical(content)) });
}
export async function buildBundle(
  definitionPath: string,
  skills: string[] = [],
  bindings: string[] = [],
): Promise<AgentBundle> {
  const root = path.dirname(path.resolve(definitionPath));
  const sourceText = await readFile(definitionPath, 'utf8');
  let agent: AgentDefinition;
  let selected: unknown;
  if (definitionPath.endsWith('.oaa')) {
    const compiled = compileOaaLang(sourceText);
    agent = compiled.agent;
    selected = compiled.files;
  } else {
    const raw = JSON.parse(sourceText) as Record<string, unknown>;
    selected = raw.files ?? [];
    delete raw.files;
    if (Array.isArray(raw.tools))
      raw.tools = raw.tools.map((t) =>
        typeof t === 'string' && builtinNames.has(t) ? builtin(t as BuiltinToolName) : t,
      );
    if (!Array.isArray(selected) || selected.some((x) => typeof x !== 'string'))
      throw new Fault('invalid_manifest', 'files must be an explicit list of relative paths.');
    agent = agentSchema.parse(raw);
  }
  if (!Array.isArray(selected) || selected.some((x) => typeof x !== 'string'))
    throw new Fault('invalid_manifest', 'files must be an explicit list of relative paths.');
  for (const selected of bindings) {
    const absolute = path.resolve(selected);
    const contents = await readBounded(path.dirname(absolute), path.basename(absolute), 1_000_000);
    agent.tools.push(bindingSchema.parse(JSON.parse(contents.toString('utf8'))));
  }
  const files: AgentBundle['files'] = [];
  for (const name of selected as string[]) {
    const bytes = await readBounded(root, relativeName(name));
    files.push({ path: name, content: bytes.toString('base64'), sha256: sha(bytes) });
  }
  for (const dir of skills) {
    const skillRoot = await realpath(dir);
    const bytes = await readBounded(skillRoot, 'SKILL.md', 200_000);
    const source = bytes.toString('utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (!match) throw new Fault('invalid_skill', 'SKILL.md needs YAML frontmatter.');
    const meta = parseYaml(match[1]!, { maxAliasCount: 20 }) as Record<string, unknown>;
    if (
      typeof meta.name !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(meta.name) ||
      typeof meta.description !== 'string'
    )
      throw new Fault('invalid_skill', 'Skill name and description are required.');
    const prefix = `skills/${meta.name}`;
    agent.skills.push({
      name: meta.name,
      description: meta.description,
      path: `${prefix}/SKILL.md`,
    });
    async function walk(rel: string): Promise<void> {
      for (const entry of await readdir(path.join(skillRoot, rel), { withFileTypes: true })) {
        const name = path.posix.join(rel, entry.name);
        if (entry.isSymbolicLink())
          throw new Fault('unsafe_bundle', `Skill symlinks are not distributed: ${name}`);
        if (forbiddenName.test(name))
          throw new Fault('unsafe_bundle', `Forbidden skill file: ${name}`);
        if (entry.isDirectory()) await walk(name);
        else if (entry.isFile()) {
          const data = await readBounded(skillRoot, name);
          files.push({
            path: `${prefix}/${name}`,
            content: data.toString('base64'),
            sha256: sha(data),
          });
          if (files.length > 500) throw new Fault('bundle_too_large', 'Too many selected files.');
        } else throw new Fault('unsafe_bundle', 'Only regular files are publishable.');
      }
    }
    await walk('');
  }
  if (
    agent.skills.length &&
    !agent.tools.some((t) => t.handler.kind === 'builtin' && t.handler.name === 'read_skill')
  )
    agent.tools.push(builtin('read_skill'));
  return makeBundle(agent, files);
}
export async function installBundle(root: string, raw: unknown): Promise<AgentBundle> {
  const bundle = validateBundle(raw);
  const dir = path.join(root, bundle.digest);
  for (const file of bundle.files) {
    try {
      await writePrivate(dir, file.path, Buffer.from(file.content, 'base64'), true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (sha(await readBounded(dir, file.path)) !== file.sha256)
        throw new Fault('bundle_integrity', 'Installed bundle has been changed.');
    }
  }
  return bundle;
}
