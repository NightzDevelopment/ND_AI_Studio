const dollars=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);

export async function renderBilling({root,api,el,button,confirmAction,current}) {
  root.replaceChildren(el('p','muted','Loading your subscription...'));
  let data=await api('/api/studio/billing');if(!current())return;
  let sequence=0;
  async function render() {
    if(!current())return;
    const revision=++sequence;
    root.replaceChildren();
    const intro=el('div','intro'),copy=el('div');copy.append(el('p','eyebrow','PREDICTABLE MONTHLY PRICING'),el('h1','','Plans & usage'),el('p','','A clear monthly allowance. No automatic overage payments. Your saved source stays accessible when your allowance runs out.'));intro.append(copy);root.append(intro);
    if(!data.enabled){root.append(el('p','notice','Subscriptions are not open yet. You can keep creating projects, editing source and downloading your files.'));return;}
    const currentPlan=data.plans.find(plan=>plan.id===data.subscription?.plan),summary=el('section','admin-card');
    summary.append(el('h2','',currentPlan?`${currentPlan.name} subscription`:'Choose your monthly plan'));
    if(data.subscription){
      const sub=data.subscription;
      summary.append(el('p','',`${data.wallet.available} credits available / ${data.wallet.reserved} reserved. ${sub.cancelAtEnd?'Paid access ends':'Current allowance ends'} ${new Date(sub.renewsAt).toLocaleString()}.`));
      if(sub.revoked)summary.append(el('p','notice error','Generation is unavailable following a payment refund or dispute. Your source files remain accessible. Contact support for help.'));
      if(data.paused)summary.append(el('p','notice error','Generation is temporarily paused after provider failures. Your unused allowance is preserved. Contact support.'));
      summary.append(button(sub.cancelAtEnd?'Keep subscription renewing':'Cancel next renewal',async()=>{
        const cancelAtEnd=!sub.cancelAtEnd;
        if(!await confirmAction(cancelAtEnd?'Cancel next renewal?':'Resume monthly renewal?',cancelAtEnd?'Your paid allowance remains available until the end of this billing period. Your source files stay accessible afterward.':`Your ${currentPlan?.name || sub.plan} subscription will renew monthly at ${dollars(sub.priceCents)}.` ,cancelAtEnd?'Cancel renewal':'Resume renewal') || !current())return;
        data=await api('/api/studio/billing/cancel',{method:'POST',body:{cancelAtEnd}});await render();
      },sub.cancelAtEnd?'primary':'secondary'));
    }
    if(data.hasCustomer)summary.append(button('Payment method & invoices',async()=>{const result=await api('/api/studio/billing/portal',{method:'POST',body:{}});if(!current())return;const target=new URL(result.url);if(target.origin!=='https://billing.stripe.com')throw new Error('Billing portal could not be verified.');location.assign(target.href);},'secondary'));
    summary.append(button('Refresh payment status',async()=>{data=await api('/api/studio/billing/refresh',{method:'POST',body:{}});await render();},'secondary'));root.append(summary);
    if(data.limits)root.append(el('p','notice',`Account safety limits: ${data.limits.dailyBuilds} build submissions per UTC day, including failed attempts, and $${(data.limits.dailyBudgetMicros/1000000).toFixed(2)} of provider spending per day. These limits apply alongside your monthly allowance.`));
    const grid=el('div','project-grid');
    for(const plan of data.plans){
      const card=el('section','admin-card billing-card');card.append(el('h2','',plan.name),el('p','billing-price',`${dollars(plan.priceCents)} / month`),el('p','',`${plan.credits.toLocaleString()} monthly AI credits`),el('p','muted',`Equivalent to ${dollars(plan.credits)} of recorded provider usage. Smaller models use fewer credits for the same token volume.`));
      if(!data.subscription){
        const label=el('label','billing-accept'),accept=el('input');accept.type='checkbox';label.append(accept,document.createTextNode(` I agree to ${dollars(plan.priceCents)} per month until canceled. Allowance resets each paid billing period; unused monthly credits do not roll over.`));
        const checkout=button(`Choose ${plan.name}`,async()=>{
          if(!accept.checked || !current())return;
          const result=await api('/api/studio/billing/checkout',{method:'POST',body:{planId:plan.id,acceptedTerms:true,pricingVersion:data.version}});
          if(!current())return;
          const target=new URL(result.url);if(target.origin!=='https://checkout.stripe.com')throw new Error('Checkout could not be verified. Please retry.');
          location.assign(target.href);
        },'primary');checkout.disabled=true;accept.disabled=plan.available===false;accept.addEventListener('change',()=>{checkout.disabled=!accept.checked || plan.available===false;});card.append(label,checkout);
        if(plan.available===false)card.append(el('p','muted','Subscriptions are temporarily unavailable for this plan. No payment will be taken.'));
      }
      grid.append(card);
    }
    root.append(grid);
    const terms=el('section','admin-card');terms.append(el('h2','','How your allowance works'));
    for(const text of ['One credit represents $0.01 of recorded provider usage, not one message or one build. Fractional usage is tracked precisely.','Each build shows its maximum credit reservation before you start. Successful delivery consumes recorded usage, including planning and automatic repairs, up to that maximum.','When a build fails or is interrupted before validated output is delivered, its entire reservation is restored. This is an allowance restoration, not a refund of your monthly subscription payment.','Monthly credits reset at the next paid billing period. Running out pauses generation without charging your card. Editing, history and downloads remain available.','You can cancel renewal here. Paid access continues through the current billing period. A delivered build can still require in-game testing and fixes.'])terms.append(el('p','',text));
    root.append(terms);
    const history=await api('/api/studio/credits');if(!current() || revision!==sequence)return;
    const section=el('section','admin-card');section.append(el('h2','','Recent usage'));
    if(!history.items.length)section.append(el('p','muted','Your build reservations and completed usage will appear here.'));
    else {
      const wrap=el('div','table-wrap'),table=el('table'),head=el('thead'),header=el('tr'),body=el('tbody');
      for(const name of ['Time','Status','Credits used','Detail'])header.append(el('th','',name));head.append(header);table.append(head,body);
      for(const item of history.items){const row=el('tr');for(const text of [new Date(item.createdAt).toLocaleString(),item.kind,item.kind==='charged'?item.amount.toLocaleString('en-US',{maximumFractionDigits:4}):'0',item.detail])row.append(el('td','',text));body.append(row);}
      wrap.append(table);section.append(wrap);
    }
    root.append(section);
  }
  await render();
}
