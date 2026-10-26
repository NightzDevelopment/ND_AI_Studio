import { refreshSelects } from './controls.js';

export function createModelControls({api,el,button,field,selectField,table,notice,confirmAction,reasonDialog,onChange,getUserId=()=>null}) {
  let data=null, selected='', fetchedAt=0, loading=null;
  let owner=getUserId(), refreshSequence=0, adminSequence=0, historySequence=0, historyDialog=null;
  const quotes=new WeakMap();
  const css=el('link'); css.rel='stylesheet'; css.href='/models.css'; document.head.append(css);
  const providerName=provider=>provider==='deepseek'?'DeepSeek':'OpenAI';
  const panel=el('div','model-selector'), label=el('label','','Coding model'), select=el('select');
  select.name='modelId'; select.setAttribute('aria-label','Coding model'); label.append(select);
  const summary=el('p','model-quote'), balance=el('p','model-wallet'), details=button('Credit history',showHistory,'credit-history-button');
  summary.setAttribute('aria-live','polite'); balance.setAttribute('aria-live','polite');
  panel.append(label,summary,balance,details); document.getElementById('build-form').prepend(panel);
  select.addEventListener('change',()=>{selected=select.value;render();onChange();});
  function syncOwner(){
    const current=getUserId();if(current===owner)return;
    owner=current;data=null;selected='';fetchedAt=0;loading=null;refreshSequence++;
    select.replaceChildren(new Option('Choose a coding model',''));
    if(historyDialog?.isConnected)historyDialog.close();
  }
  const chosen=()=>{syncOwner();return data?.models.find(model=>model.id===selected);};
  function render(locked=false) {
    syncOwner();
    select.disabled=locked || !data?.models.length;
    const model=chosen();
    summary.textContent=model ? `${providerName(model.provider)} / ${model.tier.toUpperCase()} / ${data.creditsEnabled?`${model.creditsPerBuild} credits per completed build`:'Studio credit deductions are off'}. API estimate cap: $${(model.maxBudgetMicros/1000000).toFixed(2)} per build.${model.workerReady===false?' This provider is not ready on the worker.':''}` : 'No model selected. Configure coding models in Control room.';
    const w=data?.wallet;
    balance.textContent=w ? `${w.available} credits available / ${w.reserved} reserved / ${w.pending} pending review` : 'Loading model settings...';
    details.disabled=!data;
    refreshSelects(panel);
  }
  async function refresh(force=false) {
    syncOwner();
    if (loading) return loading;
    if (!force && data && Date.now()-fetchedAt<15000) return;
    const userId=owner,sequence=++refreshSequence;
    const pending=(async()=>{
      const fresh=await api('/api/studio/models'), first=!data;
      if(userId!==getUserId() || sequence!==refreshSequence)return;
      data=fresh; fetchedAt=Date.now();
      if (first) selected=fresh.defaultModelId;
      if (!fresh.models.some(model=>model.id===selected)) selected='';
      select.replaceChildren(new Option('Choose a coding model',''),...fresh.models.map(model=>{const option=new Option(`${providerName(model.provider)} / ${model.label} / ${model.tier}${fresh.creditsEnabled?` / ${model.creditsPerBuild} credits`:''}${model.workerReady===false?' / worker unavailable':''}`,model.id);option.disabled=model.workerReady===false;return option;}));
      select.value=selected; render();
    })();
    loading=pending;
    try { await pending; } finally {if(loading===pending)loading=null;}
  }
  function available() { const model=chosen();return Boolean(model && model.workerReady!==false && (!data.creditsEnabled || data.wallet.available>=model.creditsPerBuild)); }
  async function prepare() {
    const userId=getUserId();
    await refresh(true);
    if(userId!==getUserId())throw new Error('Your account changed. Review the current model and credit balance before generating.');
    const model=chosen(); if(!model)throw new Error('Choose an enabled coding model.');
    if(model.workerReady===false)throw new Error(`The worker is not configured for ${providerName(model.provider)}. Choose an available provider or ask the owner to configure it.`);
    if(!available())throw new Error('Not enough available Studio credits for the selected model.');
    const quote=Object.freeze({modelId:model.id,pricingVersion:data.pricingVersion,quotedCredits:data.creditsEnabled?model.creditsPerBuild:0});
    quotes.set(quote,{model:{...model},creditsEnabled:data.creditsEnabled,userId});
    return quote;
  }
  function confirmation(quote) {
    const snapshot=quotes.get(quote);
    if(!snapshot || snapshot.userId!==getUserId())throw new Error('The model quote belongs to an earlier account. Review the current model before generating.');
    const {model,creditsEnabled}=snapshot;
    return `${providerName(model.provider)} / ${model.label} (${model.id}). ${creditsEnabled?`${quote.quotedCredits} Studio credits are reserved now and charged when a validated build is delivered. Failed or interrupted builds with possible API usage await owner review.`:'No Studio credits will be deducted.'} API estimate cap: $${(model.maxBudgetMicros/1000000).toFixed(2)}. Your current project snapshot and request are sent to ${providerName(model.provider)}. Validated output saves a new project revision automatically when its source revision still matches. A conflict preserves the finished output without overwriting newer source. This never deploys or runs the generated code.`;
  }
  async function showHistory() {
    const userId=getUserId(),route=location.hash,sequence=++historySequence;
    const result=await api('/api/studio/credits');if(userId!==getUserId() || route!==location.hash || sequence!==historySequence)return;
    if(historyDialog?.isConnected)historyDialog.close();
    const dialog=el('dialog','wide'), heading=el('h2','','Studio credit history');historyDialog=dialog;
    heading.id='studio-credit-history-title'; dialog.setAttribute('aria-labelledby',heading.id);
    dialog.append(heading,el('p','dialog-description',`${result.wallet.available} available. Credits are internal Studio allowances, not provider funds or a cash balance.`));
    const view=table(['Time','Action','Amount','Balance change']);
    for(const item of result.items){const row=el('tr');for(const value of [new Date(item.createdAt).toLocaleString(),item.kind,item.amount,item.delta])row.append(el('td','',value));view.body.append(row);}
    dialog.append(view.wrap,button('Close',()=>dialog.close()));dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
  }
  async function renderAdmin(root) {
    const sequence=++adminSequence,userId=getUserId(),current=()=>root.isConnected && sequence===adminSequence && userId===getUserId();
    const config=await api('/api/admin/models');if(!current())return;root.replaceChildren();
    const intro=el('section','admin-card');intro.append(el('h2','','Models & credits'),el('p','','Configure exact coding model IDs, provider token prices and separate Studio credit charges. OpenAI uses Responses with structured output; DeepSeek uses its own verified text generation adapter. Image, voice, realtime and specialist models need separate pipelines. Verify account access before enabling any model.'));
    const docs=el('a','secondary','OpenAI model documentation');docs.href='https://developers.openai.com/api/docs/models';docs.target='_blank';docs.rel='noopener noreferrer';intro.append(docs);const deepseekDocs=el('a','secondary','DeepSeek API documentation');deepseekDocs.href='https://api-docs.deepseek.com/';deepseekDocs.target='_blank';deepseekDocs.rel='noopener noreferrer';intro.append(deepseekDocs);root.append(intro);
    const form=el('form','model-catalog-form'), rows=el('div','model-cards');
    const charge=check('Enforce Studio credits for new builds',config.creditsEnabled);
    const defaults=selectField('Default coding model',[['','Choose a default model']],config.defaultModelId,'defaultModelId');
    const header=el('section','admin-card');header.append(charge.label,el('p','fine muted','Off by default. Enabling requires real owner-granted balances. No checkout, purchases, exchange rate or credit expiry is configured. Validated builds consume the displayed fixed model charge; zero-usage failures release their hold. Other failed or interrupted outcomes require owner reconciliation.'),defaults.label);
    form.append(header,rows);root.append(form);
    const editors=[];
    function updateDefaults(){
      const previous=defaults.input.value || config.defaultModelId;
      const enabled=editors.filter(item=>item.card.isConnected && item.controls.enabled.checked && item.controls.id.value.trim());
      defaults.input.replaceChildren(new Option('Choose a default model',''),...enabled.map(item=>new Option(item.controls.label.value || item.controls.id.value,item.controls.id.value.trim())));
      defaults.input.value=previous;refreshSelects(header);
    }
    function addModel(model={id:'',label:'',tier:'standard',enabled:false,compatible:false,inputUsdPerMillion:0,cachedInputUsdPerMillion:0,outputUsdPerMillion:0,maxOutputTokens:8192,maxCalls:2,maxBudgetMicros:500000,timeoutSeconds:180,creditsPerBuild:0}) {
      model={provider:'openai',cacheWritePolicy:'provider-default',cacheWrite30mUsdPerMillion:null,cacheWrite12hUsdPerMillion:null,longContextThreshold:null,longContextInputMultiplier:1,longContextOutputMultiplier:1,...model};
      if(editors.filter(item=>item.card.isConnected).length>=40)throw new Error('At most 40 models can be configured.');
      const card=el('details','admin-card model-card');card.open=!model.id;
      const title=el('summary','',model.label || 'New coding model');card.append(title);
      const grid=el('div','model-fields'), controls={};
      const provider=selectField('Generation provider',[['openai','OpenAI'],['deepseek','DeepSeek']],model.provider,'provider');controls.provider=provider.input;grid.append(provider.label);
      const definitions=[['id','Exact API model ID','text'],['label','Display name','text'],['inputUsdPerMillion','Input USD / 1M tokens','number',0,10000,.000001],['cachedInputUsdPerMillion','Cached input USD / 1M','number',0,10000,.000001],['outputUsdPerMillion','Output USD / 1M tokens','number',0,10000,.000001],['creditsPerBuild','Credits / completed build','number',0,1000000,1],['maxOutputTokens','Maximum output tokens','number',512,65536,1],['maxCalls','Maximum calls per build','number',1,2,1],['budget','API estimate cap / build (USD)','number',.01,100,.01],['timeoutSeconds','Request timeout (seconds)','number',30,900,1]];
      for(const [name,text,type,min,max,step] of definitions){const f=field(text,type,name==='budget'?model.maxBudgetMicros/1000000:model[name],name);f.input.required=true;if(min!==undefined){f.input.min=min;f.input.max=max;f.input.step=step;}else f.input.maxLength=name==='id'?100:80;controls[name]=f.input;grid.append(f.label);}
      const tier=selectField('Tier',[['budget','Budget'],['standard','Standard'],['premium','Premium']],model.tier,'tier');controls.tier=tier.input;grid.append(tier.label);
      const cache=selectField('Provider cache writes',[['provider-default','Provider default'],['disabled','Disabled when supported']],model.cacheWritePolicy,'cacheWritePolicy');controls.cacheWritePolicy=cache.input;grid.append(cache.label);
      const optional=[['cacheWrite30mUsdPerMillion','Cache write 30m USD / 1M (blank if unverified)',0,10000,.000001],['cacheWrite12hUsdPerMillion','Cache write 12h USD / 1M (blank if unverified)',0,10000,.000001],['longContextThreshold','Long context threshold in input tokens (blank if none)',1,10000000,1]];
      for(const [name,text,min,max,step]of optional){const f=field(text,'number',model[name]??'',name);f.input.min=min;f.input.max=max;f.input.step=step;controls[name]=f.input;grid.append(f.label);}
      for(const [name,text]of [['longContextInputMultiplier','Long context input price multiplier'],['longContextOutputMultiplier','Long context output price multiplier']]){const f=field(text,'number',model[name],name);f.input.required=true;f.input.min=1;f.input.max=10;f.input.step=.01;controls[name]=f.input;grid.append(f.label);}
      const enabled=check('Available in the model selector',model.enabled), compatible=check('I verified this provider adapter, structured output and account access',model.compatible);controls.enabled=enabled.input;controls.compatible=compatible.input;
      card.append(grid,compatible.label,enabled.label,el('p','fine muted','Token prices estimate provider spending, not customer payments. Set premium models to a higher credit cost where appropriate. Leave unavailable models disabled.'),button('Remove model',async()=>{if(!current()||!card.isConnected)return;if(await confirmAction('Remove this model?', 'It will be removed after saving the catalog. Existing jobs retain their captured model and price.','Remove model')&&current()&&card.isConnected){card.remove();updateDefaults();}},'danger'));
      editors.push({card,controls});rows.append(card);refreshSelects(card);
      controls.id.addEventListener('input',updateDefaults);controls.enabled.addEventListener('change',updateDefaults);controls.label.addEventListener('input',()=>{title.textContent=controls.label.value || 'New coding model';updateDefaults();});updateDefaults();
    }
    for(const model of config.models)addModel(model);
    if(config.presets?.length){
      const presets=el('section','admin-card'),picker=selectField('Verified coding preset',[['','Choose a reviewed preset'],...config.presets.map((preset,index)=>[String(index),`${providerName(preset.provider)} / ${preset.label}`])],'','preset');
      const evidence=el('div','preset-evidence');evidence.setAttribute('aria-live','polite');
      const add=button('Add disabled preset',()=>{
        const preset=config.presets[Number(picker.input.value)];if(!preset||picker.input.value==='')return;
        if(editors.some(item=>item.card.isConnected&&item.controls.id.value.trim()===preset.id))throw new Error('This model is already in the catalog. Edit its existing settings.');
        const {verification,...model}=preset;addModel({...model,enabled:false,compatible:false});
        editors.at(-1).card.open=true;notice('Preset added disabled. Verify access, prices and Studio credit costs before enabling it.');
      });add.disabled=true;
      picker.input.addEventListener('change',()=>{
        evidence.replaceChildren();const preset=config.presets[Number(picker.input.value)];add.disabled=!preset||picker.input.value==='';if(add.disabled)return;
        evidence.append(el('p','fine muted',`Reviewed ${preset.verification?.checkedAt||'date unavailable'}. Input: $${preset.inputUsdPerMillion} / 1M. Cached input: $${preset.cachedInputUsdPerMillion} / 1M. Output: $${preset.outputUsdPerMillion} / 1M.`));
        evidence.append(el('p','fine muted',preset.verification?.notes||'Verify the current official documentation and account access before use.'));
        for(const source of preset.verification?.sources||[]){try{const url=new URL(source);if(url.protocol!=='https:')continue;const link=el('a','secondary','Official source');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';evidence.append(link);}catch{}}
      });
      presets.append(el('h3','','Reviewed coding presets'),el('p','fine muted','Importing a preset adds an editable disabled entry. It does not enable generation, replace existing models, change your default, grant credits or make a provider request.'),picker.label,evidence,add);header.after(presets);refreshSelects(presets);
    }
    const actions=el('div','actions');actions.append(button('+ Add model',()=>addModel()));
    const save=el('button','primary','Save model catalog');save.type='submit';actions.append(save);
    const message=el('p','form-error');message.hidden=true;message.setAttribute('role','alert');form.append(message,actions);
    function catalogBody(){
      const models=editors.filter(item=>item.card.isConnected).map(({controls:c})=>({id:c.id.value.trim(),label:c.label.value.trim(),provider:c.provider.value,tier:c.tier.value,enabled:c.enabled.checked,compatible:c.compatible.checked,cacheWritePolicy:c.cacheWritePolicy.value,
          cacheWrite30mUsdPerMillion:c.cacheWrite30mUsdPerMillion.value===''?null:Number(c.cacheWrite30mUsdPerMillion.value),cacheWrite12hUsdPerMillion:c.cacheWrite12hUsdPerMillion.value===''?null:Number(c.cacheWrite12hUsdPerMillion.value),longContextThreshold:c.longContextThreshold.value===''?null:Number(c.longContextThreshold.value),longContextInputMultiplier:Number(c.longContextInputMultiplier.value),longContextOutputMultiplier:Number(c.longContextOutputMultiplier.value),
          inputUsdPerMillion:Number(c.inputUsdPerMillion.value),cachedInputUsdPerMillion:Number(c.cachedInputUsdPerMillion.value),outputUsdPerMillion:Number(c.outputUsdPerMillion.value),creditsPerBuild:Number(c.creditsPerBuild.value),maxOutputTokens:Number(c.maxOutputTokens.value),maxCalls:Number(c.maxCalls.value),maxBudgetMicros:Math.round(Number(c.budget.value)*1000000),timeoutSeconds:Number(c.timeoutSeconds.value)}));
      return {version:config.version,models,defaultModelId:defaults.input.value,creditsEnabled:charge.input.checked};
    }
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(save.disabled||!current())return;save.disabled=true;message.hidden=true;
      try{
        const body=catalogBody();
        if(body.creditsEnabled && !config.creditsEnabled && !await confirmAction('Enable Studio credit deductions?', 'Members, including owners, will need enough owner-granted credits. This does not create payments or credit sales.','Enable credits'))return;
        if(!current())return;
        const saved=await api('/api/admin/models',{method:'PATCH',body});
        if(!current())return;
        if(!Number.isSafeInteger(saved?.version)||saved.version<=body.version||typeof saved.creditsEnabled!=='boolean'||typeof saved.defaultModelId!=='string')throw new Error('The service did not confirm a saved catalog. Keep your edits and reload its current version before trying again.');
        const newer=JSON.stringify(catalogBody())!==JSON.stringify(body);
        config.version=saved.version;config.creditsEnabled=saved.creditsEnabled;config.defaultModelId=saved.defaultModelId;
        notice(newer?'Model catalog saved. Your newer catalog edits are still unsaved.':'Model catalog saved. Existing queued builds keep their original pricing.');
        await refresh(true).catch(()=>{if(current())notice(newer?'Model catalog saved. Your newer edits remain unsaved. Reload model balances if they appear out of date.':'Model catalog saved. Reload model balances if they appear out of date.');});
      }catch(failure){message.textContent=failure.message;message.hidden=false;}finally{save.disabled=false;}
    });
    await creditAdmin(root,current);if(current())refreshSelects(root);
  }
  function check(text,checked){const label=el('label','check'),input=el('input');input.type='checkbox';input.checked=checked;label.append(input,document.createTextNode(text));return {label,input};}
  async function creditAdmin(root,current){
    if(!current())return;
    const section=el('section','admin-card');section.append(el('h2','','Credit balances & reconciliation'),el('p','','Grant or adjust internal testing credits for a registered Discord user. Every adjustment needs a reason and is audited. Nothing is charged to a payment card.'));
    const search=field('Personal Discord user ID','text','','discordId');search.input.maxLength=20;
    let walletSequence=0;
    function invalidateWallet(message){
      walletSequence++;
      for(const node of display.querySelectorAll('form [type=submit]'))node.disabled=true;
      const status=display.querySelector('[data-wallet-context]');if(status){status.textContent=message;status.hidden=false;}
      return walletSequence;
    }
    const display=el('div'),load=button('Load account',async()=>{
      if(!current())return;
      const query=search.input.value.trim(),sequence=invalidateWallet('Loading the current balance. Previous adjustment inputs are kept until this account loads.');
      const result=await api(`/api/admin/credits?discordId=${encodeURIComponent(query)}`);
      if(!current()||sequence!==walletSequence||query!==search.input.value.trim())return;
      renderWallet(result,sequence);
    });
    search.input.addEventListener('input',()=>invalidateWallet('Load this account before adjusting credits.'));
    section.append(search.label,load,display);root.append(section);
    function renderWallet(result,sequence){
      let wallet=result;
      const active=()=>current()&&sequence===walletSequence&&search.input.value.trim()===wallet.user.discordId;
      const heading=el('h3','',wallet.user.displayName),totals=el('p'),ledger=el('div');
      display.replaceChildren(heading,totals);
      const contextNote=el('p','fine muted');contextNote.dataset.walletContext='';contextNote.hidden=true;contextNote.setAttribute('role','status');display.append(contextNote);
      const form=el('form'),amount=field('Credit adjustment (negative removes unused credits)','number',0,'amount'),reason=field('Reason','text','','reason');
      amount.input.min=-1000000;amount.input.max=1000000;amount.input.step=1;amount.input.required=true;reason.input.required=true;reason.input.maxLength=300;
      const save=el('button','primary','Apply credit adjustment');save.type='submit';const message=el('p','form-error');message.hidden=true;
      form.append(amount.label,reason.label,message,save);display.append(form,ledger);let pending=null;
      function renderBalance(){
        heading.textContent=wallet.user.displayName;
        totals.textContent=`${wallet.wallet.available} available / ${wallet.wallet.reserved} reserved / ${wallet.wallet.pending} pending review`;ledger.replaceChildren();
        if(wallet.items.length){const view=table(['Action','Amount','Change','Reason']);for(const item of wallet.items){const row=el('tr');for(const value of [item.kind,item.amount,item.delta,item.detail])row.append(el('td','',value));view.body.append(row);}ledger.append(el('p','fine muted','Latest 100 credit events'),view.wrap);}
      }
      renderBalance();
      form.addEventListener('submit',async event=>{event.preventDefault();if(save.disabled||!active())return;save.disabled=true;message.hidden=true;
        try{
          const submitted={amount:amount.input.value,reason:reason.input.value};
          const body={discordId:wallet.user.discordId,amount:Number(submitted.amount),reason:submitted.reason.trim(),version:wallet.wallet.version};
          if(!body.amount)throw new Error('Enter a non-zero credit amount.');
          if(!await confirmAction('Adjust this credit balance?',`${wallet.user.displayName}: ${body.amount} credits. Reason: ${body.reason}`,'Apply adjustment')||!active())return;
          const key=JSON.stringify(body);if(!pending || pending.key!==key)pending={key,requestId:crypto.randomUUID()};
          const updated=await api('/api/admin/credits',{method:'POST',body:{...body,requestId:pending.requestId}});
          if(updated?.user?.discordId!==body.discordId||!Number.isSafeInteger(updated.wallet?.version))throw new Error('The service did not confirm this credit adjustment. Reload the account before trying again.');
          pending=null;if(!current())return;
          if(!active()){notice(`Credit adjustment recorded for ${updated.user.displayName}. Reload that account to review its balance.`);return;}
          const newer=amount.input.value!==submitted.amount||reason.input.value!==submitted.reason;
          wallet=updated;renderBalance();if(!newer){amount.input.value='0';reason.input.value='';}
          notice(newer?'Credit adjustment recorded. Your newer adjustment inputs are still unsent.':'Credit adjustment recorded.');
          await refresh(true).catch(()=>{if(current())notice('Credit adjustment recorded. Reload balances if they appear out of date.');});
        }catch(failure){if(current()&&form.isConnected){message.textContent=failure.message;message.hidden=false;}}finally{save.disabled=!active();}
      });
    }
    const pending=await api('/api/admin/credits/pending');if(!current())return;
    const holds=el('section','admin-card');holds.append(el('h2','','Pending credit holds'),el('p','fine muted','These holds are not finalized charges. Check the build and provider usage, then record your decision. Provider spending is separate and is not refunded by releasing Studio credits.'));
    for(const item of pending.items){const row=el('div','credit-hold'),copy=el('div');copy.append(el('strong','',`${item.displayName} / ${item.projectName}`),el('p','',`${item.amount} credits held / ${item.status} / API estimate $${(item.providerCostMicros/1000000).toFixed(4)}`));
      let resolving=false;
      const actions=el('div','actions');for(const [action,text]of [['released','Release hold'],['charged','Finalize charge']])actions.append(button(text,async()=>{
        if(resolving||!current()||!row.isConnected)return;resolving=true;
        try{const reason=await reasonDialog(text,`${item.displayName}: ${item.amount} credits. This does not change provider billing.`);if(reason===null||!current()||!row.isConnected)return;await api('/api/admin/credits/resolve',{method:'POST',body:{jobId:item.jobId,action,reason}});if(!current())return;row.remove();notice('Credit hold resolved.');await refresh(true);}finally{resolving=false;}
      },action==='charged'?'danger':''));row.append(copy,actions);holds.append(row);}
    if(!pending.items.length)holds.append(el('p','muted','No credits are awaiting review.'));root.append(holds);
  }
  return {refresh,render,available,prepare,confirmation,renderAdmin};
}
