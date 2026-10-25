import { refreshSelects } from './controls.js';

export function createModelControls({api,el,button,field,selectField,table,notice,confirmAction,reasonDialog,onChange}) {
  let data=null, selected='', fetchedAt=0, loading=null;
  const css=el('link'); css.rel='stylesheet'; css.href='/models.css'; document.head.append(css);
  const panel=el('div','model-selector'), label=el('label','','OpenAI coding model'), select=el('select');
  select.name='modelId'; select.setAttribute('aria-label','OpenAI coding model'); label.append(select);
  const summary=el('p','model-quote'), balance=el('p','model-wallet'), details=button('Credit history',showHistory,'credit-history-button');
  summary.setAttribute('aria-live','polite'); balance.setAttribute('aria-live','polite');
  panel.append(label,summary,balance,details); document.getElementById('build-form').prepend(panel);
  select.addEventListener('change',()=>{selected=select.value;render();onChange();});
  const chosen=()=>data?.models.find(model=>model.id===selected);
  function render(locked=false) {
    select.disabled=locked || !data?.models.length;
    const model=chosen();
    summary.textContent=model ? `${model.tier.toUpperCase()} / ${data.creditsEnabled?`${model.creditsPerBuild} credits per completed build`:'Studio credit deductions are off'}. API estimate cap: $${(model.maxBudgetMicros/1000000).toFixed(2)} per build.` : 'No model selected. Configure coding models in Control room.';
    const w=data?.wallet;
    balance.textContent=w ? `${w.available} credits available / ${w.reserved} reserved / ${w.pending} pending review` : 'Loading model settings...';
    details.disabled=!data;
    refreshSelects(panel);
  }
  async function refresh(force=false) {
    if (loading) return loading;
    if (!force && data && Date.now()-fetchedAt<15000) return;
    loading=(async()=>{
      const fresh=await api('/api/studio/models'), first=!data;
      data=fresh; fetchedAt=Date.now();
      if (first) selected=fresh.defaultModelId;
      if (!fresh.models.some(model=>model.id===selected)) selected='';
      select.replaceChildren(new Option('Choose a coding model',''),...fresh.models.map(model=>new Option(`${model.label} / ${model.tier}${fresh.creditsEnabled?` / ${model.creditsPerBuild} credits`:''}`,model.id)));
      select.value=selected; render();
    })();
    try { await loading; } finally {loading=null;}
  }
  function available() { const model=chosen();return Boolean(model && (!data.creditsEnabled || data.wallet.available>=model.creditsPerBuild)); }
  async function prepare() {
    await refresh(true);
    const model=chosen(); if(!model)throw new Error('Choose an enabled OpenAI coding model.');
    if(!available())throw new Error('Not enough available Studio credits for the selected model.');
    return {modelId:model.id,pricingVersion:data.pricingVersion,quotedCredits:data.creditsEnabled?model.creditsPerBuild:0};
  }
  function confirmation(quote) {
    const model=chosen();
    return `${model.label} (${model.id}). ${data.creditsEnabled?`${quote.quotedCredits} Studio credits are reserved now and charged when a validated build is delivered. Failed or interrupted builds with possible API usage await owner review.`:'No Studio credits will be deducted.'} API estimate cap: $${(model.maxBudgetMicros/1000000).toFixed(2)}. Your current project snapshot and request are sent to OpenAI. Validated output saves a new project revision automatically when its source revision still matches. A conflict preserves the finished output without overwriting newer source. This never deploys or runs the generated code.`;
  }
  async function showHistory() {
    const result=await api('/api/studio/credits'), dialog=el('dialog','wide'), heading=el('h2','','Studio credit history');
    heading.id='studio-credit-history-title'; dialog.setAttribute('aria-labelledby',heading.id);
    dialog.append(heading,el('p','dialog-description',`${result.wallet.available} available. Credits are internal Studio allowances, not OpenAI funds or a cash balance.`));
    const view=table(['Time','Action','Amount','Balance change']);
    for(const item of result.items){const row=el('tr');for(const value of [new Date(item.createdAt).toLocaleString(),item.kind,item.amount,item.delta])row.append(el('td','',value));view.body.append(row);}
    dialog.append(view.wrap,button('Close',()=>dialog.close()));dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
  }
  async function renderAdmin(root) {
    const config=await api('/api/admin/models');root.replaceChildren();
    const intro=el('section','admin-card');intro.append(el('h2','','Models & credits'),el('p','','Configure exact OpenAI API model IDs, token prices and Studio credit charges. Only text models supporting the Responses API with structured JSON output are compatible. Models listed in ChatGPT are not automatically available to your API project.'));
    const docs=el('a','secondary','OpenAI model documentation');docs.href='https://developers.openai.com/api/docs/models';docs.target='_blank';docs.rel='noopener noreferrer';intro.append(docs);root.append(intro);
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
      if(editors.filter(item=>item.card.isConnected).length>=40)throw new Error('At most 40 models can be configured.');
      const card=el('details','admin-card model-card');card.open=!model.id;
      const title=el('summary','',model.label || 'New OpenAI model');card.append(title);
      const grid=el('div','model-fields'), controls={};
      const definitions=[['id','Exact API model ID','text'],['label','Display name','text'],['inputUsdPerMillion','Input USD / 1M tokens','number',0,10000,.000001],['cachedInputUsdPerMillion','Cached input USD / 1M','number',0,10000,.000001],['outputUsdPerMillion','Output USD / 1M tokens','number',0,10000,.000001],['creditsPerBuild','Credits / completed build','number',0,1000000,1],['maxOutputTokens','Maximum output tokens','number',512,65536,1],['maxCalls','Maximum calls per build','number',1,2,1],['budget','API estimate cap / build (USD)','number',.01,100,.01],['timeoutSeconds','Request timeout (seconds)','number',30,900,1]];
      for(const [name,text,type,min,max,step] of definitions){const f=field(text,type,name==='budget'?model.maxBudgetMicros/1000000:model[name],name);f.input.required=true;if(min!==undefined){f.input.min=min;f.input.max=max;f.input.step=step;}else f.input.maxLength=name==='id'?100:80;controls[name]=f.input;grid.append(f.label);}
      const tier=selectField('Tier',[['budget','Budget'],['standard','Standard'],['premium','Premium']],model.tier,'tier');controls.tier=tier.input;grid.append(tier.label);
      const enabled=check('Available in the model selector',model.enabled), compatible=check('I verified Responses API + structured JSON support and API-project access',model.compatible);controls.enabled=enabled.input;controls.compatible=compatible.input;
      card.append(grid,compatible.label,enabled.label,el('p','fine muted','Token prices estimate provider spending, not customer payments. Set premium models to a higher credit cost where appropriate. Leave unavailable models disabled.'),button('Remove model',async()=>{if(await confirmAction('Remove this model?', 'It will be removed after saving the catalog. Existing jobs retain their captured model and price.','Remove model')){card.remove();updateDefaults();}},'danger'));
      editors.push({card,controls});rows.append(card);refreshSelects(card);
      controls.id.addEventListener('input',updateDefaults);controls.enabled.addEventListener('change',updateDefaults);controls.label.addEventListener('input',()=>{title.textContent=controls.label.value || 'New OpenAI model';updateDefaults();});updateDefaults();
    }
    for(const model of config.models)addModel(model);
    const actions=el('div','actions');actions.append(button('+ Add model',()=>addModel()));
    const save=el('button','primary','Save model catalog');save.type='submit';actions.append(save);
    const message=el('p','form-error');message.hidden=true;message.setAttribute('role','alert');form.append(message,actions);
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(save.disabled)return;save.disabled=true;message.hidden=true;
      try{
        if(charge.input.checked && !config.creditsEnabled && !await confirmAction('Enable Studio credit deductions?', 'Members, including owners, will need enough owner-granted credits. This does not create payments or credit sales.','Enable credits'))return;
        const models=editors.filter(item=>item.card.isConnected).map(({controls:c})=>({id:c.id.value.trim(),label:c.label.value.trim(),tier:c.tier.value,enabled:c.enabled.checked,compatible:c.compatible.checked,
          inputUsdPerMillion:Number(c.inputUsdPerMillion.value),cachedInputUsdPerMillion:Number(c.cachedInputUsdPerMillion.value),outputUsdPerMillion:Number(c.outputUsdPerMillion.value),creditsPerBuild:Number(c.creditsPerBuild.value),maxOutputTokens:Number(c.maxOutputTokens.value),maxCalls:Number(c.maxCalls.value),maxBudgetMicros:Math.round(Number(c.budget.value)*1000000),timeoutSeconds:Number(c.timeoutSeconds.value)}));
        await api('/api/admin/models',{method:'PATCH',body:{version:config.version,models,defaultModelId:defaults.input.value,creditsEnabled:charge.input.checked}});
        notice('Model catalog saved. Existing queued builds keep their original pricing.');await refresh(true);await renderAdmin(root);
      }catch(failure){message.textContent=failure.message;message.hidden=false;}finally{save.disabled=false;}
    });
    await creditAdmin(root);refreshSelects(root);
  }
  function check(text,checked){const label=el('label','check'),input=el('input');input.type='checkbox';input.checked=checked;label.append(input,document.createTextNode(text));return {label,input};}
  async function creditAdmin(root){
    const section=el('section','admin-card');section.append(el('h2','','Credit balances & reconciliation'),el('p','','Grant or adjust internal testing credits for a registered Discord user. Every adjustment needs a reason and is audited. Nothing is charged to a payment card.'));
    const search=field('Personal Discord user ID','text','','discordId');search.input.maxLength=20;
    const display=el('div'), load=button('Load account',async()=>renderWallet(await api(`/api/admin/credits?discordId=${encodeURIComponent(search.input.value.trim())}`)));
    section.append(search.label,load,display);root.append(section);
    function renderWallet(result){
      display.replaceChildren(el('h3','',result.user.displayName),el('p','',`${result.wallet.available} available / ${result.wallet.reserved} reserved / ${result.wallet.pending} pending review`));
      const form=el('form'),amount=field('Credit adjustment (negative removes unused credits)','number',0,'amount'),reason=field('Reason','text','','reason');
      amount.input.min=-1000000;amount.input.max=1000000;amount.input.step=1;amount.input.required=true;reason.input.required=true;reason.input.maxLength=300;
      const save=el('button','primary','Apply credit adjustment');save.type='submit';const message=el('p','form-error');message.hidden=true;
      form.append(amount.label,reason.label,message,save);display.append(form);let pending=null;
      form.addEventListener('submit',async event=>{event.preventDefault();if(save.disabled)return;save.disabled=true;message.hidden=true;
        try{
          const body={discordId:result.user.discordId,amount:Number(amount.input.value),reason:reason.input.value.trim(),version:result.wallet.version};
          if(!body.amount)throw new Error('Enter a non-zero credit amount.');
          if(!await confirmAction('Adjust this credit balance?',`${result.user.displayName}: ${body.amount} credits. Reason: ${body.reason}`,'Apply adjustment'))return;
          const key=JSON.stringify(body);if(!pending || pending.key!==key)pending={key,requestId:crypto.randomUUID()};
          const updated=await api('/api/admin/credits',{method:'POST',body:{...body,requestId:pending.requestId}});pending=null;
          notice('Credit adjustment recorded.');renderWallet(updated);await refresh(true);
        }catch(failure){message.textContent=failure.message;message.hidden=false;}finally{save.disabled=false;}
      });
      if(result.items.length){const view=table(['Action','Amount','Change','Reason']);for(const item of result.items){const row=el('tr');for(const value of [item.kind,item.amount,item.delta,item.detail])row.append(el('td','',value));view.body.append(row);}display.append(el('p','fine muted','Latest 100 credit events'),view.wrap);}
    }
    const pending=await api('/api/admin/credits/pending'), holds=el('section','admin-card');holds.append(el('h2','','Pending credit holds'),el('p','fine muted','These holds are not finalized charges. Check the build and provider usage, then record your decision. Provider spending is separate and is not refunded by releasing Studio credits.'));
    for(const item of pending.items){const row=el('div','credit-hold'),copy=el('div');copy.append(el('strong','',`${item.displayName} / ${item.projectName}`),el('p','',`${item.amount} credits held / ${item.status} / API estimate $${(item.providerCostMicros/1000000).toFixed(4)}`));
      const actions=el('div','actions');for(const [action,text]of [['released','Release hold'],['charged','Finalize charge']])actions.append(button(text,async()=>{const reason=await reasonDialog(text,`${item.displayName}: ${item.amount} credits. This does not change OpenAI billing.`);if(reason===null)return;await api('/api/admin/credits/resolve',{method:'POST',body:{jobId:item.jobId,action,reason}});row.remove();notice('Credit hold resolved.');await refresh(true);},action==='charged'?'danger':''));row.append(copy,actions);holds.append(row);}
    if(!pending.items.length)holds.append(el('p','muted','No credits are awaiting review.'));root.append(holds);
  }
  return {refresh,render,available,prepare,confirmation,renderAdmin};
}
