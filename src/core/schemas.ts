import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Fault, canonical, sha } from './util.js';

export class JsonSchemas {
  private compiled = new Map<string, ValidateFunction>();
  private formatter = new Ajv();
  private errors: ErrorObject[] | null | undefined;
  compile(schema: Record<string, unknown>): ValidateFunction {
    if (schema.$async)
      throw new Fault('schema_dialect_unsupported', 'Asynchronous JSON schemas are not supported.');
    const key = sha(canonical(schema));
    const cached = this.compiled.get(key);
    if (cached) {
      this.compiled.delete(key);
      this.compiled.set(key, cached);
      return cached;
    }
    const options = { strict: false, allErrors: true, ownProperties: true };
    const dialect =
      typeof schema.$schema === 'string' ? schema.$schema.replace(/#$/, '') : schema.$schema;
    // Keep schema IDs local to this immutable contract, not shared across tool versions.
    const validator =
      dialect === 'https://json-schema.org/draft/2020-12/schema'
        ? new Ajv2020(options)
        : dialect === 'https://json-schema.org/draft/2019-09/schema'
          ? new Ajv2019(options)
          : dialect === undefined ||
              dialect === 'http://json-schema.org/draft-07/schema' ||
              dialect === 'https://json-schema.org/draft-07/schema'
            ? new Ajv(options)
            : undefined;
    if (!validator)
      throw new Fault(
        'schema_dialect_unsupported',
        'Supported JSON schema drafts are 2020-12, 2019-09, and draft-07.',
      );
    if (dialect === 'https://json-schema.org/draft-07/schema') {
      const meta = validator.getSchema('http://json-schema.org/draft-07/schema')?.schema;
      if (meta && typeof meta === 'object')
        validator.addMetaSchema(meta, 'https://json-schema.org/draft-07/schema');
    }
    let check: ValidateFunction;
    try {
      check = validator.compile(schema);
    } catch {
      throw new Fault(
        'invalid_schema',
        'JSON schema is invalid or references an unavailable external schema.',
      );
    }
    this.compiled.set(key, check);
    if (this.compiled.size > 128) this.compiled.delete(this.compiled.keys().next().value!);
    return check;
  }
  validate(schema: Record<string, unknown>, value: unknown): boolean {
    const check = this.compile(schema);
    const valid = check(value);
    this.errors = check.errors;
    return valid as boolean;
  }
  errorsText(errors = this.errors): string {
    return this.formatter.errorsText(errors);
  }
}
