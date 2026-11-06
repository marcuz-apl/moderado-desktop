import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const catalogOf = (source) => source.slice(source.indexOf('pub const PRESETS'), source.indexOf('impl ProviderId'));

test('llama.cpp sits between OpenRouter and Ollama on port 9931', async () => {
  const provider = await read('src-tauri/src/provider.rs');
  const catalog = catalogOf(provider);
  const ids = [...catalog.matchAll(/id:\s*ProviderId::(\w+)/g)].map((match) => match[1]);
  assert.deepEqual(ids, [
    'Moderado',
    'NvidiaNim',
    'OpenRouter',
    'LlamaCpp',
    'Ollama',
    'LmStudio',
    'OpenAiCompatible',
  ]);
  const block = catalog.slice(catalog.indexOf('id: ProviderId::LlamaCpp'), catalog.indexOf('id: ProviderId::Ollama'));
  assert.match(block, /name: "llama\.cpp"/, 'the Settings label is exactly llama.cpp');
  assert.match(block, /default_base_url: "http:\/\/127\.0\.0\.1:9931\/v1"/, 'the preset uses the requested port on IPv4 loopback');
  assert.match(block, /local: true/, 'a local runtime needs no API key');
  assert.match(block, /keyless: false/, 'only the Gateway has free stealth models');
  assert.match(block, /apply_key_url: Some\("https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases"\)/);
  assert.match(block, /apply_key_label: "Get llama\.cpp"/);
  assert.match(provider, /OpenRouter,\s*LlamaCpp,\s*Ollama,/, 'the enum keeps the same order');
});

test('every local runtime is probed without a provider-specific branch', async () => {
  const provider = await read('src-tauri/src/provider.rs');
  const probe = provider.slice(provider.indexOf('pub async fn probe_local_providers'), provider.indexOf('pub async fn chat_completion'));
  assert.match(probe, /local_presets\(\)/);
  assert.match(probe, /futures_util::future::join_all/);
  assert.doesNotMatch(probe, /ProviderId::(Ollama|LmStudio|LlamaCpp)\.preset\(\)/, 'no hardcoded probe list');
  assert.match(provider, /fn local_presets\(\) -> impl Iterator<Item = &'static ProviderPreset> \{[\s\S]*?PRESETS\.iter\(\)\.filter\(\|preset\| preset\.local\)/);
});

test('the renderer, agent fixture matrix, and docs know about llama.cpp', async () => {
  const [main, runner, fixture, readme, manual] = await Promise.all([
    read('src/renderer/main.ts'),
    read('src-tauri/src/agent/runner.rs'),
    read('src-tauri/tests/fixtures/llama_cpp.sse'),
    read('README.md'),
    read('docs/manual.md'),
  ]);
  assert.match(main, /'open_router' \| 'llama_cpp' \| 'ollama'/);
  assert.match(main, /'lm_studio' \| 'open_ai_compatible'/, 'the custom endpoint id matches serde');
  assert.match(runner, /ProviderId::LlamaCpp,\s*include_str!\("\.\.\/\.\.\/tests\/fixtures\/llama_cpp\.sse"\)/);
  assert.match(fixture, /write_file/);
  assert.match(readme, /\| llama\.cpp \(local\) \| `http:\/\/127\.0\.0\.1:9931\/v1` \| none \|/);
  assert.match(manual, /llama\.cpp, Ollama, and LM Studio need no key/);
});
