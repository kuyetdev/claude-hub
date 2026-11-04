import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHubReportHook(value: unknown): boolean {
  return object(value) && Array.isArray(value.hooks) && value.hooks.some((hook) => {
    if (!object(hook) || typeof hook.command !== 'string') return false;
    return hook.command.includes('report') && (hook.command.includes('claude-hub-agent') || hook.command.includes('/agent/cli.ts'));
  });
}

export async function installClaudeHook(settingsPath: string, command: string): Promise<void> {
  let settings: JsonObject = {};
  let existingMode = 0o600;
  let exists = false;
  try {
    const raw = await readFile(settingsPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed)) throw new Error('settings.json phải chứa một JSON object.');
    settings = parsed;
    existingMode = (await stat(settingsPath)).mode & 0o777;
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const hooks = object(settings.hooks) ? settings.hooks : {};
  const currentStop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  hooks.Stop = [
    ...currentStop.filter((entry) => !isHubReportHook(entry)),
    { hooks: [{ type: 'command', command, timeout: 20, async: true }] },
  ];
  settings.hooks = hooks;

  await mkdir(dirname(settingsPath), { recursive: true });
  if (exists) await copyFile(settingsPath, `${settingsPath}.claude-hub.bak`);
  const temporary = `${settingsPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: existingMode });
  await chmod(temporary, existingMode);
  await rename(temporary, settingsPath);
}
