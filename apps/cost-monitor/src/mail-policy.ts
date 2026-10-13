import type {Notice,State} from "./engine";
export const DIGEST_MS=60*60_000;
// Customer mail covers observed failures, slow business functions and confirmed
// account-level spend signals. Collection gaps and per-resource optimizations
// remain available to operators without creating another customer incident.
export function userFacing(n:Pick<Notice,"key">):boolean {
  // These are the exact monitor names from wrangler.jsonc and the local E2E
  // runner. Its own runtime failure belongs to the independent ops watchdog.
  if(/^Workers:ghfind-cost-monitor(?:-e2e|-local|-local-e2e)?:errors$/.test(n.key))return false;
  return n.key.startsWith("Service:") || n.key.startsWith("Workers:")&&n.key.endsWith(":errors") || n.key==="account:burn" || n.key==="Billing:account:daily";
}
export function discardInternalMail(state:State):number {
  const before=state.outbox.length;
  state.outbox=state.outbox.filter(userFacing);
  if(state.collection){
    delete state.collection.acceptedRecipients;
    delete state.collection.notified;
    delete state.collection.lastNotifiedAt;
  }
  return before-state.outbox.length;
}
export function urgent(n:Notice):boolean {
  return userFacing(n) && n.severity>=2 && (n.kind==="open"||n.kind==="escalation") && (n.key.startsWith("Service:")&&n.key.endsWith(":errors") || n.key==="account:burn" || n.key==="Billing:account:daily");
}
export function selectMail(pending:Notice[],now:number,nextDigest:number):Notice[]{
  return pending.filter(n=>userFacing(n)&&(now>=nextDigest||urgent(n)));
}
