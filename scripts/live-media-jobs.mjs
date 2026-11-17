import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [base, tokenFile, agent, output] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base ?? '') || !tokenFile || !agent || !output)
  throw Error('Use an isolated loopback gateway, token file, agent and new output directory.');
const token = (await readFile(tokenFile, 'utf8')).trim();
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const ffmpeg = JSON.stringify(process.env.FFMPEG_BINARY ?? 'ffmpeg');
await mkdir(output, { recursive: false });
const report = { started: new Date().toISOString(), agent, cases: [] };
for (const item of [
  {
    kind: 'audio',
    format: 'wav',
    task: `Use the installed ffmpeg executable ${ffmpeg} to create a one-second 440Hz sine test signal as PCM WAV. This is a technical test signal, not speech or an artistic performance.`,
  },
  {
    kind: 'video',
    format: 'mp4',
    task: `Use the installed ffmpeg executable ${ffmpeg} to create a one-second 64x64 moving testsrc video at 10fps in MP4. This is a technical test pattern, not an AI-generated cinematic video.`,
  },
]) {
  const start = Date.now();
  let id;
  try {
    const response = await fetch(`${base}/v1/media/jobs`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        agent,
        model: 'default',
        kind: item.kind,
        format: item.format,
        input: `${item.task} Stay inside the isolated task working directory and write the requested file to the downloadable outputs directory. Do not inspect existing projects, credentials or personal files. Do not use the network or change global settings. Return DONE when the file exists.`,
      }),
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error?.code ?? `HTTP_${response.status}`);
    id = value.id;
    const deadline = Date.now() + 180000;
    let result;
    while (Date.now() < deadline) {
      result = await (
        await fetch(`${base}/v1/media/jobs/${id}`, { headers, signal: AbortSignal.timeout(10000) })
      ).json();
      if (['completed', 'failed', 'interrupted', 'incomplete', 'cancelled'].includes(result.status))
        break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (result?.status !== 'completed')
      throw Error(result?.error?.code ?? result?.status ?? 'timeout');
    const artifact = result.artifacts.find((a) => a.kind === item.kind);
    if (!artifact) throw Error('missing_artifact');
    const download = await fetch(`${base}/v1/files/${artifact.id}/content`, { headers });
    if (!download.ok) throw Error('download_failed');
    const file = path.join(output, `${item.kind}.${item.format}`);
    const bytes = Buffer.from(await download.arrayBuffer());
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
        { encoding: 'utf8' },
      ),
    );
    const stream = probe.streams.find((s) => s.codec_type === item.kind);
    const ok = !!stream && Number(probe.format.duration) > 0;
    const row = {
      kind: item.kind,
      ok,
      id,
      bytes: bytes.length,
      elapsedMs: Date.now() - start,
      validation: result.validation,
      codec: stream?.codec_name,
      duration: probe.format.duration,
    };
    report.cases.push(row);
    console.log(JSON.stringify(row));
  } catch (error) {
    if (id)
      await fetch(`${base}/v1/responses/${id}/cancel`, { method: 'POST', headers }).catch(() => {});
    report.cases.push({
      kind: item.kind,
      ok: false,
      id,
      elapsedMs: Date.now() - start,
      error: error.message,
    });
    console.log(JSON.stringify(report.cases.at(-1)));
  }
}
await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2), {
  flag: 'wx',
  mode: 0o600,
});
process.exitCode = report.cases.every((c) => c.ok) ? 0 : 1;
