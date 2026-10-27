import { fields, insist, string, filePath } from './studio-domain.mjs';

export const ACTIONS = ['list_files','read_file','search_files','write_file','delete_file','validate_project','propose_plan','ask_user','finish'];

export function actionData(value) {
  fields(value,['type','message','path','query','content','plan']);
  insist(ACTIONS.includes(value.type),400,'Unknown agent tool.');
  const message=string(value.message,2000,'action summary',true);
  const needsPath=['read_file','write_file','delete_file'].includes(value.type);
  // Nullable schema strings can be empty. Only neutral, unused arguments are
  // normalized; required arguments and nonempty paths retain the source rules.
  const path=value.path===null||!needsPath&&value.path===''?null:filePath(value.path);
  const query=value.query===null||value.type!=='search_files'&&value.query===''?null:string(value.query,200,'search query');
  insist(value.content===null||typeof value.content==='string'&&!value.content.includes('\0')&&Buffer.byteLength(value.content)<=65536,400,'Invalid tool content.');
  insist(value.plan===null||typeof value.plan==='object'&&!Array.isArray(value.plan),400,'Invalid plan result.');
  if(needsPath)insist(path!==null,400,'This tool needs a path.');
  if(value.type==='write_file')insist(typeof value.content==='string',400,'Write the complete file content.');
  if(value.type==='search_files')insist(query!==null,400,'This tool needs a query.');
  if(value.type==='propose_plan')insist(value.plan!==null,400,'This tool needs a plan.');
  return {type:value.type,message,path,query,content:value.content,plan:value.plan};
}
