async function loadStagingRefreshPanel(){
 const requested=workspaceId;
 try{
  const status=await api('/api/staging-refresh/status');if(!status.enabled||view!=='settings'||workspaceId!==requested)return;
  const panel=document.createElement('section');panel.className='panel';panel.style.marginTop='24px';
  panel.innerHTML='<div class="panelhead"><h2>Refresh staging from production export</h2></div><div class="panelbody stack"><p>Replace staging business records with a production workspace JSON export. Staging sign-in accounts stay separate, outgoing email is disabled, and a staging backup is saved first.</p><p>This is a one-way snapshot. Later changes in either environment are not synchronized.</p><button onclick="document.getElementById(\'staging-source\').click()">Choose production workspace export</button><input id="staging-source" type="file" accept="application/json,.json" hidden onchange="prepareStagingImport(this.files[0]);this.value=\'\'"></div>';
  document.querySelector('.content').append(panel);
 }catch{/* This optional tool is unavailable on production and older deployments. */}
}
async function prepareStagingImport(file){
 if(!file)return;
 try{
  if(file.size>5000000)throw Error('Choose a workspace JSON export smaller than 5 MB.');
  const source=JSON.parse(await file.text());if(!validBackup(source)||source.version!==2)throw Error('Choose the production Settings → Export workspace backup JSON file.');
  showModal('Replace staging business data?',`<p>This will replace staging with <strong>${source.employees.length} employees, ${source.contracts.length} contracts, ${source.sheets.length} timesheets, and ${source.invoices.length} invoices</strong> from ${esc(source.settings.business)}.</p><p style="margin-top:12px">Production is unchanged. Staging logins are retained and matching employees are linked by email. A staging backup will be saved before replacement.</p>`, '<button id="cancel-staging-refresh">Cancel</button><button id="confirm-staging-refresh" class="primary">Back up and refresh staging</button>');
  document.getElementById('cancel-staging-refresh').onclick=closeModal;
  document.getElementById('confirm-staging-refresh').onclick=async()=>{
   const button=document.getElementById('confirm-staging-refresh');button.disabled=true;
   try{
    await saveQueue;if(saveFailure)throw Error('Resolve unsaved changes before refreshing staging.');
    download('staging-before-refresh-'+today()+'.json',JSON.stringify(state,null,2),'application/json');
    const result=await api('/api/staging-refresh',{method:'POST',body:JSON.stringify({data:source,revision})});
    await loadWorkspace();view='settings';render();
    showModal('Staging data refreshed',`<p>The imported business data is ready for testing. Production and staging accounts were not changed.</p><p style="margin-top:12px">Your previous staging workspace was saved on the staging disk as ${esc(result.backup)}.</p>`,'<button onclick="closeModal()">Done</button>');
   }catch(error){toast(error.message);button.disabled=false}
  };
 }catch(error){toast(error.message)}
}
