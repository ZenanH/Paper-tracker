import { z } from 'zod';
import type { Store } from './db/index.ts';
import { aiURL, aiRequest, ExternalError } from './network.ts';
import { AppError, decrypt, encrypt, hash } from './security.ts';
import { recordConfigurationChanged } from './config-sync.ts';

export type AISettings = { id: number; base_url: string; encrypted_key: string | null; model: string; filter_prompt: string; provider_version: number; filter_prompt_version: number; config_version: number };
export function aiSettings(s: Store) { return s.one<AISettings>('SELECT * FROM ai_settings WHERE id=1')!; }
export function publicSettings(s: Store) {
  const row = aiSettings(s), i = s.installation();
  return { baseURL: row.base_url, model: row.model, hasKey: !!row.encrypted_key, filterPrompt: row.filter_prompt, configVersion: row.config_version, installedAt: i.installed_at, deploymentMonthStart: i.deployment_month_start, hour: i.schedule_hour, minute: i.schedule_minute };
}
export function aiReady(settings: AISettings) { return !!(settings.base_url && settings.model && settings.encrypted_key); }
export function filterKey(titleHash: string, settings: AISettings, journalVersion: number) {
  return hash(JSON.stringify([titleHash, settings.filter_prompt_version, settings.filter_prompt, settings.provider_version, settings.model, journalVersion]));
}
export function translationKey(titleHash: string, settings: AISettings) { return hash(JSON.stringify([titleHash, 'zh-CN', 'title-translation-v1', settings.provider_version, settings.model])); }
const settingsInput = z.object({ baseURL: z.string().max(1000), apiKey: z.string().max(4096).optional(), deleteKey: z.boolean().optional(), model: z.string().max(200), filterPrompt: z.string().min(10).max(6000), confirmReprocess: z.boolean().default(false) });
export function saveSettings(s: Store, input: unknown) {
  const data = settingsInput.parse(input), old = aiSettings(s);
  const base = data.baseURL.trim().replace(/\/+$/, '');
  if (base) aiURL(base);
  const providerChanged = base !== old.base_url || data.model.trim() !== old.model;
  const promptChanged = data.filterPrompt !== old.filter_prompt;
  const credentialsChanged = !!data.apiKey?.trim() || !!(data.deleteKey && old.encrypted_key);
  if (!providerChanged && !promptChanged && !credentialsChanged) return publicSettings(s);
  const hasHistory = s.one<{ n: number }>('SELECT COUNT(*) AS n FROM paper_state WHERE archived_at IS NULL')!.n;
  if ((providerChanged || promptChanged) && hasHistory && !data.confirmReprocess) {
    throw new AppError(`此更改会使当前 ${hasHistory} 篇未归档论文的相应 AI 结果需要重新处理，请确认范围后保存。`, 409, 'reprocess_confirmation_required');
  }
  return s.transaction(() => {
    s.run('UPDATE ai_settings SET base_url=?,encrypted_key=?,model=?,filter_prompt=?,provider_version=provider_version+?,filter_prompt_version=filter_prompt_version+?,config_version=config_version+1 WHERE id=1', [base, data.deleteKey ? null : data.apiKey?.trim() ? encrypt(data.apiKey.trim()) : old.encrypted_key, data.model.trim(), data.filterPrompt, +providerChanged, +promptChanged]);
    if (providerChanged || promptChanged) {
      s.run("UPDATE task SET state='cancelled',lease_owner=NULL,lease_until=NULL,fence=fence+1 WHERE kind IN ('filter','translate') AND state IN ('queued','running','retry','blocked','failed')");
      s.run("INSERT OR IGNORE INTO task(kind,dedupe_key,payload,created_at,updated_at) VALUES('projection',?,'{}',?,?)", [`projection:${aiSettings(s).config_version}`, Date.now(), Date.now()]);
    }
    const ready = aiReady(aiSettings(s));
    // Credential changes also fence in-flight calls. A deleted key must not leave
    // unclaimable queued tasks holding the workspace update lock indefinitely.
    s.run(`UPDATE task SET state=?,next_attempt_at=0,lease_owner=NULL,lease_until=NULL,fence=fence+1,error_code=? WHERE kind IN ('filter','translate') AND state IN ('queued','running','retry','blocked')`, [ready ? 'queued' : 'blocked', ready ? null : 'ai_not_configured']);
    s.touch(true);
    recordConfigurationChanged(s);
    return publicSettings(s);
  });
}
export async function testAI(s: Store, signal?: AbortSignal) {
  const settings = aiSettings(s);
  if (!aiReady(settings)) throw new AppError('请先保存 baseURL、key 和 model。');
  await complete(settings, '仅返回 JSON 对象 {"ok":true}。', [{ paperId: 'connection-test', title: 'Connection test' }], signal);
  return { ok: true };
}
const responsesProviders = new Set<string>();
export async function complete(settings: AISettings, system: string, papers: { paperId: string; title: string }[], signal?: AbortSignal): Promise<unknown> {
  let response: unknown;
  const provider = JSON.stringify([settings.base_url, settings.model, settings.provider_version]);
  try {
    if (responsesProviders.has(provider)) throw new ExternalError('ai_http_400', false);
    response = await aiRequest(settings.base_url, decrypt(settings.encrypted_key!), {
      model: settings.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(papers) }],
      max_tokens: 1800
    }, signal);
  } catch (error) {
    if (!(error instanceof ExternalError) || !['ai_http_400', 'ai_http_404'].includes(error.code)) throw error;
    const raw = await aiRequest(settings.base_url, decrypt(settings.encrypted_key!), {
      model: settings.model, instructions: system, input: JSON.stringify(papers), max_output_tokens: 1800, store: false
    }, signal, 'responses');
    const result = z.object({ status: z.literal('completed'), output: z.array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() })) }).safeParse(raw);
    if (!result.success) throw new ExternalError('ai_invalid_response', true);
    if (responsesProviders.size >= 16) responsesProviders.clear();
    responsesProviders.add(provider);
    const text = result.data.output.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text || '').join('');
    response = { choices: [{ message: { content: text } }] };
  }
  const parsed = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().max(32000) }) })).min(1) }).safeParse(response);
  if (!parsed.success) throw new ExternalError('ai_invalid_response', true);
  const content = parsed.data.choices[0].message.content.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try { return JSON.parse(content); }
  catch { throw new ExternalError('ai_invalid_json', true); }
}
export const filterResultSchema = z.object({ results: z.array(z.object({ paperId: z.string(), decision: z.enum(['keep', 'exclude', 'uncertain']), reason: z.string().max(600) })).max(10) });
export const translationResultSchema = z.object({ results: z.array(z.object({ paperId: z.string(), titleZh: z.string().min(1).max(16000) })).max(10) });
