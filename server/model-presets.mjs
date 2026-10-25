// Reference prices checked against official documentation on 2026-10-25.
// Importing a preset never grants provider access, enables a model or changes a wallet.
const checkedAt='2026-10-25';
const openai=(id,label,tier,input,cached,output,credits)=>({
  id,label,tier,provider:'openai',enabled:false,compatible:false,
  inputUsdPerMillion:input,cachedInputUsdPerMillion:cached,outputUsdPerMillion:output,
  cacheWritePolicy:'disabled',cacheWrite30mUsdPerMillion:input*1.25,cacheWrite12hUsdPerMillion:input*2.5,
  longContextThreshold:272000,longContextInputMultiplier:2,longContextOutputMultiplier:1.5,
  maxOutputTokens:tier==='budget'?8192:16384,maxCalls:2,maxBudgetMicros:tier==='premium'?1000000:500000,timeoutSeconds:180,creditsPerBuild:credits,
  verification:{checkedAt,sources:[`https://developers.openai.com/api/docs/models/${id}`,'https://developers.openai.com/api/docs/pricing','https://developers.openai.com/api/docs/guides/prompt-caching'],
    notes:'Standard global USD prices per million tokens. Responses and structured output documented; 1,050,000-token context and 128,000-token provider output maximum. Studio uses lower output limits and disables prompt caching with explicit mode and no breakpoints. Above 272,000 input tokens, all input/cache rates double and output is 1.5x. Provider access has not been tested. Suggested Studio credits are editable allowances, not a provider exchange rate.'}
});
const deepseek=(id,label,tier,input,cached,output,credits)=>({
  id,label,tier,provider:'deepseek',enabled:false,compatible:false,
  inputUsdPerMillion:input,cachedInputUsdPerMillion:cached,outputUsdPerMillion:output,
  cacheWritePolicy:'provider-default',cacheWrite30mUsdPerMillion:0,cacheWrite12hUsdPerMillion:0,
  longContextThreshold:null,longContextInputMultiplier:1,longContextOutputMultiplier:1,
  maxOutputTokens:8192,maxCalls:2,maxBudgetMicros:500000,timeoutSeconds:180,creditsPerBuild:credits,
  verification:{checkedAt,sources:['https://api-docs.deepseek.com/quick_start/pricing/','https://api-docs.deepseek.com/guides/responses_api','https://api-docs.deepseek.com/api/create-response'],
    notes:'Conservative peak USD prices per million tokens; official off-peak prices are lower. Documented 1M-token context and 384K-token output maximum; Studio uses lower output limits. Uses DeepSeek Responses with thinking disabled and provider-managed cache. Exact account access and a live generation have not been tested. Suggested Studio credits are owner-editable.'}
});
export const VERIFIED_PRESETS=[
  openai('gpt-6-luna','GPT-6 Luna','budget',.10,.01,.50,2),
  openai('gpt-6.1-sol','GPT-6.1 Sol','standard',2,.10,10,10),
  openai('gpt-6-astra','GPT-6 Astra','premium',10,1,50,30),
  deepseek('deepseek-flash','DeepSeek Flash','budget',.30,.006,1.20,2),
  deepseek('deepseek-v4-pro','DeepSeek V4 Pro','premium',1.32,.044,3.96,8),
];
