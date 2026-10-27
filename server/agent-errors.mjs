import { fields, insist } from './studio-domain.mjs';

// Only these fixed messages cross the provider/worker boundary. Never forward
// exception messages, response bodies, prompts, source or authorization headers.
const CATEGORIES = Object.freeze({
  provider_authentication:['Provider authentication rejected.', 'Check the selected provider credential privately on the worker and confirm its account access. Do not replace credentials based on this message alone.'],
  provider_access:['Provider model or account access rejected.', 'Confirm the exact selected model, account permissions and provider restrictions. Do not switch providers or retry paid work automatically.'],
  provider_request:['Provider request contract rejected.', 'Review supported request parameters and the structured-output schema for the selected model.'],
  provider_rate_limit:['Provider rate limit reached.', 'Inspect provider limits and the recorded request identifier before authorizing another task.'],
  provider_quota:['Provider quota or billing allowance exhausted.', 'Check the provider account quota privately. Studio has not increased spending or retried the request.'],
  provider_unavailable:['Provider service unavailable.', 'Check provider availability and the request identifier. A new paid attempt requires explicit authorization.'],
  provider_timeout:['Provider request timed out.', 'The original request may have been billed. Reconcile its request identifier before authorizing new paid work.'],
  provider_network:['Provider connection interrupted.', 'Delivery is uncertain. Check connectivity and reconcile the original request before authorizing another paid attempt.'],
  provider_incomplete:['Provider output was incomplete.', 'Review the selected model output limit and task scope before authorizing another task.'],
  provider_refusal:['Provider declined the request.', 'Review the task against provider policy. No alternate provider or automatic paid retry was used.'],
  provider_output:['Provider structured output was malformed.', 'Inspect the adapter contract and recorded response identifier. No returned action was executed.'],
  invalid_action:['The model returned an invalid agent action.', 'Review the tool argument contract. Required paths, queries and complete file contents must be valid before execution.'],
  action_permission:['The agent action was not authorized.', 'Review project permissions, protected paths and the exact approved plan. Redirect and reapprove material changes.'],
  action_conflict:['The agent action could not use the current task state.', 'Inspect the recorded action result and current source. Read existing files and revalidate the approved scope before continuing.'],
  budget:['The approved task allowance was exhausted.', 'Staged work is preserved. Review it before explicitly authorizing another capped task.'],
  validator_infrastructure:['Isolated validator infrastructure failed.', 'Check the rootless validator environment. No paid source repair was requested.'],
  usage_unreconciled:['Provider usage could not be priced reliably.', 'Reconcile the captured usage and exact model rates. Unknown usage is not free; additional paid steps are blocked.'],
  receipt_uncertain:['Worker delivery ended without a confirmed receipt.', 'Inspect the persisted task and provider records before authorizing any new paid request.'],
  platform:['The task stopped after a platform failure.', 'Check worker and API availability. Staged work is preserved and no automatic paid retry was made.'],
  provider_unknown:['Provider API failure.', 'Inspect the provider request record and worker availability before explicitly authorizing another task.'],
});
const CODES = new Set(['invalid_api_key','authentication_error','permission_denied','model_not_found','invalid_request_error','invalid_json_schema','unsupported_parameter','unsupported_value','rate_limit_exceeded','insufficient_quota','quota_exceeded','billing_hard_limit_reached','context_length_exceeded','max_output_tokens','content_filter','server_error','timeout','cache-write-lifetimes-unavailable','cache-write-price-unconfigured']);
const requestId = value => typeof value === 'string' && /^(?:req_[A-Za-z0-9_-]{1,100}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value);
const responseId = value => typeof value === 'string' && /^resp_[A-Za-z0-9_-]{1,100}$/.test(value);

export function failureDiagnostic(category, details = {}) {
  if (typeof category!=='string'||!Object.hasOwn(CATEGORIES,category)) category='platform';
  const [summary,nextStep]=CATEGORIES[category];
  return {category,summary,nextStep,
    ...(Number.isInteger(details.httpStatus)&&details.httpStatus>=400&&details.httpStatus<=599?{httpStatus:details.httpStatus}:{}),
    ...(CODES.has(details.providerCode)?{providerCode:details.providerCode}:{}),
    ...(requestId(details.requestId)?{requestId:details.requestId}:{}),
    ...(responseId(details.responseId)?{responseId:details.responseId}:{}),
  };
}
export function diagnosticData(value) {
  fields(value,['category','summary','nextStep','httpStatus','providerCode','requestId','responseId']);
  insist(typeof value.category==='string'&&Object.hasOwn(CATEGORIES,value.category),400,'Invalid task diagnostic category.');
  // Messages are regenerated from the category even for authenticated workers.
  return failureDiagnostic(value.category,value);
}
export function providerHttpDiagnostic(status, code, requestIdValue) {
  let category='provider_request';
  if(['insufficient_quota','quota_exceeded','billing_hard_limit_reached'].includes(code))category='provider_quota';
  else if(status===401)category='provider_authentication';
  else if(status===403||status===404)category='provider_access';
  else if(status===429)category='provider_rate_limit';
  else if(status===408||status===504)category='provider_timeout';
  else if(status>=500)category='provider_unavailable';
  return failureDiagnostic(category,{httpStatus:status,providerCode:code,requestId:requestIdValue});
}
