import { describe,expect,it } from "vitest";
import { acknowledge,compact,emptyState,evaluate,MAX_DIAGNOSTIC_METRICS,MAX_DIAGNOSTIC_NOTICES,MAX_METRICS,MAX_STATE_BYTES,recipients,reminderInterval,STATE_TTL_MS,WINDOW_MS,type Frame,type Point,type State } from "../engine";
import { renderMail } from "../mail";
const base=1_800_000_000_000;
function frame(i:number,efficiency=200,extra:Partial<Point>={}):Frame {
  return {at:base+i*WINDOW_MS,healthy:["D1","Workers","R2","KV","DO","Queues"],errors:[],points:[{key:"D1:core:read",product:"D1",resource:"core",label:"read",amount:100*efficiency,operations:100,efficiency,unit:"rows",usd:0,efficiencyWarning:50_000,efficiencyCritical:200_000,minAmount:100_000,...extra}]};
}
function run(s:State,i:number,eff=200,extra:Partial<Point>={}){evaluate(s,frame(i,eff,extra),base+i*WINDOW_MS);}
function ack(s:State,i:number){for(const n of [...s.outbox]){n.delivered=["one@example.org","two@example.org"];acknowledge(s,n,base+i*WINDOW_MS);}}
describe("bounded Cloudflare incident policy",()=>{
  it("reported daily billing describes its actual period and amount without storage/window estimates",()=>{
    const s=emptyState();run(s,1,200,{key:"Billing:account:daily",product:"Billing",resource:"2026-01-01",label:"reported daily cost",amount:12.345,operations:1,efficiency:undefined,gauge:true,unit:"USD/day",usd:0});
    expect(s.outbox[0].text).toContain("已上报日费用：$12.3450");
    expect(s.outbox[0].text).toContain("对应日期：2026-01-01");
    expect(s.outbox[0].text).toContain("每 6 小时重新对账");
    expect(s.outbox[0].text).not.toMatch(/GB-month|本窗口按超额单价/);
  });

  it("supports extensible recipient lists and empty placeholders, rejects invalid lists",()=>{
    expect(recipients('["One@example.org","","two@example.org","one@example.org"]')).toEqual(["one@example.org","two@example.org"]);
    for(const x of ['[]','[null]','["bad"]','["a@x.y\\nBcc: z@x.y"]'])expect(()=>recipients(x)).toThrow();
  });
  it("does not mistake traffic growth for per-query amplification",()=>{
    const s=emptyState();for(let i=1;i<=20;i++)run(s,i);
    run(s,21,200,{amount:20_000_000,operations:100_000});
    expect(s.outbox).toHaveLength(0);
  });
  it("detects the original 380k rows/query regression without waiting for baseline training",()=>{
    const s=emptyState();run(s,1,380_000);
    expect(s.outbox[0]).toMatchObject({kind:"open",severity:2});
    expect(s.outbox[0].evidence?.threshold).toBe("每次操作 ≥ 200000 rows");
    expect(s.metrics['D1:core:read'].trigger?.basis).toBe("absolute");
  });
  it("explains a relative regression below the absolute threshold in both structured evidence and rendered mail",()=>{
    const s=emptyState();for(let i=1;i<=14;i++)run(s,i,1000,{operations:1000,amount:1_000_000,usd:0.001});
    run(s,15,45_000,{operations:1000,amount:45_000_000,usd:0.045});
    const notice=s.outbox.find(n=>n.key==='D1:core:read')!;
    expect(notice.severity).toBe(2);expect(s.metrics[notice.key].trigger?.basis).toBe("relative");
    expect(notice.evidence?.threshold).toContain("相对健康基线 ≥ 10 倍");
    expect(notice.evidence?.threshold).toContain("$0.5/h");
    expect(notice.evidence?.value).toContain("45.00 倍，$0.54/h");
    expect(notice.evidence?.threshold).not.toContain("200000");
    const mail=renderMail([notice],{accountId:"account",now:base+15*WINDOW_MS});
    expect(mail.text).toContain("45.00 倍，$0.54/h");expect(mail.html).toContain("相对健康基线 ≥ 10 倍");
    expect(mail.text).not.toContain("≥ 200000");expect(mail.html).not.toContain("≥ 200000");
  });
  it("does not label the same 45x ratio critical when its cost only meets the warning floor",()=>{
    const s=emptyState();for(let i=1;i<=14;i++)run(s,i,1000,{operations:100,amount:100_000,usd:0.0001});
    run(s,15,45_000,{operations:100,amount:4_500_000,usd:0.0045});expect(s.outbox).toEqual([]);
    run(s,16,45_000,{operations:100,amount:4_500_000,usd:0.0045});
    const notice=s.outbox.find(n=>n.key==='D1:core:read')!;
    expect(notice.severity).toBe(1);expect(notice.evidence?.threshold).toContain("相对健康基线 ≥ 3 倍");
    expect(notice.evidence?.threshold).toContain("$0.05/h");expect(notice.evidence?.threshold).not.toContain("$0.5/h");
  });
  it("separates latched historical severity from a currently weaker condition and clears it on recovery",()=>{
    const s=emptyState();for(let i=1;i<=14;i++)run(s,i,1000,{operations:1000,amount:1_000_000,usd:0.001});
    run(s,15,45_000,{operations:1000,amount:45_000_000,usd:0.045});
    const trigger=structuredClone(s.metrics['D1:core:read'].trigger);
    run(s,16,60_000,{operations:100,amount:6_000_000,usd:0.006});
    expect(s.metrics['D1:core:read'].severity).toBe(2);expect(s.metrics['D1:core:read'].trigger).toEqual(trigger);
    const notice=s.outbox.find(n=>n.key==='D1:core:read')!;
    expect(notice.evidence?.threshold).toContain("历史严重触发");expect(notice.evidence?.threshold).toContain("45.00 倍");
    expect(notice.evidence?.impact).toContain("当前仅满足普通条件：每次操作 ≥ 50000 rows");
    expect(notice.evidence?.threshold).not.toContain("200000");
    run(s,17,1000,{operations:100,amount:100_000,usd:0.0001});
    expect(s.outbox.find(n=>n.key==='D1:core:read')?.evidence?.impact).toContain("当前未再次确认原告警级别");
    ack(s,17);run(s,18,1000,{operations:100,amount:100_000,usd:0.0001});
    expect(s.metrics['D1:core:read'].trigger).toBeUndefined();
    expect(s.outbox.find(n=>n.key==='D1:core:read')?.evidence?.threshold).toBe("已连续两个有效窗口恢复正常");
  });
  it("does not invent an absolute trigger for a latched incident migrated without original evidence",()=>{
    const s=emptyState();run(s,1,380_000);delete s.metrics['D1:core:read'].trigger;
    run(s,2,200);
    expect(s.outbox[0].evidence?.threshold).toContain("旧状态未保存原始触发依据");
    expect(s.outbox[0].evidence?.threshold).not.toContain("200000");
  });
  it("requires consecutive closed windows for a warning, ignores duplicate/replayed windows",()=>{
    const s=emptyState();run(s,1,60_000);run(s,1,60_000);expect(s.outbox).toHaveLength(0);
    run(s,2,60_000);expect(s.outbox[0].severity).toBe(1);
    const snapshot=JSON.stringify(s);run(s,1,380_000);expect(JSON.stringify(s)).toBe(snapshot);
  });
  it("a telemetry gap does not manufacture consecutive warning windows",()=>{
    const s=emptyState();run(s,1,60_000);run(s,3,60_000);expect(s.outbox).toHaveLength(0);
  });
  it("a corrected partial window fills missing sources without training healthy metrics twice",()=>{
    const s=emptyState();const partial=frame(1);partial.healthy=["D1"];partial.errors=["Workers unavailable"];evaluate(s,partial,base+WINDOW_MS);
    const seen=s.metrics['D1:core:read'].good;evaluate(s,frame(1),base+WINDOW_MS+1);
    expect(s.metrics['D1:core:read'].good).toBe(seen);expect(s.lastError).toBeNull();expect(s.lastSuccess).toBe(base+WINDOW_MS+1);
  });
  it("a per-source collection gap does not count as consecutive breaches",()=>{
    const s=emptyState();run(s,1,60_000);evaluate(s,{at:base+2*WINDOW_MS,healthy:["Workers"],points:[],errors:["D1 unavailable"]},base+2*WINDOW_MS);
    run(s,3,60_000);expect(s.outbox).toHaveLength(0);
  });
  it("freezes a healthy baseline throughout an incident",()=>{
    const s=emptyState();for(let i=1;i<=20;i++)run(s,i);const before=s.metrics['D1:core:read'].baseline;
    for(let i=21;i<=40;i++)run(s,i,380_000);
    expect(s.metrics['D1:core:read'].baseline).toBe(before);
  });
  it("reminds at six hours, escalates immediately, recovers only after two valid windows",()=>{
    const s=emptyState();run(s,1,60_000);run(s,2,60_000);ack(s,2);
    run(s,3,380_000);expect(s.outbox[0].kind).toBe("escalation");ack(s,3);
    run(s,8,380_000);expect(s.outbox).toHaveLength(0);
    run(s,74,380_000);expect(s.outbox).toHaveLength(0);
    run(s,75,380_000);expect(s.outbox[0].kind).toBe("reminder");ack(s,75);
    run(s,76);expect(s.outbox).toHaveLength(0);
    run(s,77);expect(s.outbox[0].kind).toBe("recovery");
    expect(reminderInterval("Billing:account:daily")).toBe(24*3600_000);
  });
  it("drops a partially delivered open after recovery instead of notifying remaining recipients of a stale fault",()=>{
    const s=emptyState();run(s,1,380_000);
    s.outbox[0].delivered=["one@example.org"];s.outbox[0].attempts=2;
    run(s,2);expect(s.outbox).toHaveLength(1);
    run(s,3);expect(s.metrics['D1:core:read'].severity).toBe(0);expect(s.outbox).toEqual([]);
    run(s,4,380_000);expect(s.outbox[0]).toMatchObject({kind:"open",delivered:[]});
  });
  it("replaces a pending reminder or escalation with current recovery evidence",()=>{
    for(const kind of ["reminder","escalation"] as const){
      const s=emptyState();run(s,1,60_000);run(s,2,60_000);ack(s,2);
      const start=kind==="reminder"?74:3;
      run(s,start,kind==="reminder"?60_000:380_000);
      expect(s.outbox[0].kind).toBe(kind);s.outbox[0].delivered=["one@example.org"];
      run(s,start+1);run(s,start+2);
      expect(s.outbox).toHaveLength(1);expect(s.outbox[0]).toMatchObject({kind:"recovery",severity:0,delivered:[]});
      expect(s.outbox[0].text).toContain("已连续两个有效窗口恢复正常");
    }
  });
  it("silently closes recovered service failures even when only one recipient received the open",()=>{
    const s=emptyState(),extra={key:"Service:scan:errors",product:"Service" as const,gauge:true,relative:false,minAmount:1,efficiencyWarning:undefined,efficiencyCritical:0};
    run(s,1,1,extra);expect(s.outbox[0].severity).toBe(2);s.outbox[0].delivered=["one@example.org"];
    run(s,2,0,extra);run(s,3,0,extra);
    expect(s.outbox).toEqual([]);expect(s.metrics[extra.key].notifiedSeverity).toBe(0);
  });
  it("keeps an incident active when its source fails or diagnostics are incomplete",()=>{
    const s=emptyState();run(s,1,380_000);ack(s,1);
    for(let i=2;i<=3;i++)evaluate(s,{at:base+i*WINDOW_MS,healthy:["Workers","R2","KV"],points:[],errors:["D1 unavailable"]},base+i*WINDOW_MS);
    expect(s.metrics['D1:core:read'].severity).toBe(2);expect(s.outbox).toHaveLength(0);
    run(s,4,380_000,{key:"D1:core:sql-fingerprint",diagnostic:true});
    run(s,5,380_000,{key:"D1:core:sql-fingerprint",diagnostic:true});ack(s,5);
    for(let i=6;i<=7;i++)evaluate(s,{at:base+i*WINDOW_MS,healthy:["D1"],points:[],errors:[],completeQueries:false},base+i*WINDOW_MS);
    expect(s.metrics['D1:core:sql-fingerprint'].severity).toBe(2);
  });
  it("does not turn a missing storage snapshot into zero storage",()=>{
    const s=emptyState();run(s,1,380_000,{gauge:true});ack(s,1);
    for(let i=2;i<=3;i++)evaluate(s,{at:base+i*WINDOW_MS,healthy:["D1"],points:[],errors:[]},base+i*WINDOW_MS);
    expect(s.metrics['D1:core:read'].severity).toBe(2);
  });
  it("does not double count SQL diagnostic cost or declare account burn recovered on partial data",()=>{
    const s=emptyState();const f=frame(1,380_000,{usd:1,diagnostic:true});evaluate(s,f,base+WINDOW_MS);
    expect(s.metrics['account:burn'].severity).toBe(0);
    const total=frame(2,200,{usd:2});evaluate(s,total,base+2*WINDOW_MS);expect(s.metrics['account:burn'].severity).toBe(2);ack(s,2);
    for(let i=3;i<=4;i++)evaluate(s,{...frame(i),healthy:["D1"]},base+i*WINDOW_MS);
    expect(s.metrics['account:burn'].severity).toBe(2);
  });
  it("rejects a five-minute spike but confirms sustained critical burn after fifteen minutes",()=>{
    const s=emptyState();
    for(let i=1;i<=12;i++)run(s,i);
    run(s,13,200,{usd:0.2});
    expect(s.metrics['account:burn'].severity).toBe(0);
    expect(s.outbox).toEqual([]);
    run(s,14);run(s,15);
    for(let i=16;i<=18;i++)run(s,i,200,{usd:0.2});
    const notice=s.outbox.find(n=>n.key==='account:burn');
    expect(notice).toMatchObject({severity:2,kind:"open"});
    expect(notice?.evidence?.value).toContain("15 分钟 $2.40/h");
    expect(s.metrics['account:burn'].burnWindows).toHaveLength(12);
  });
  it("detects intermittent sustained cost with weighted fifteen-minute and one-hour windows",()=>{
    const s=emptyState();
    for(let i=1;i<=11;i++){run(s,i,200,{usd:i%2 ? 0.1 : 0});expect(s.outbox).toEqual([]);}
    run(s,12,200,{usd:0.05});
    expect(s.outbox.find(n=>n.key==='account:burn')).toMatchObject({severity:1});
  });
  it("never fills unknown cost windows with zero or counts duplicate corrections twice",()=>{
    const s=emptyState();run(s,1,200,{usd:0.2});run(s,1,200,{usd:0.2});
    expect(s.metrics['account:burn'].burnWindows).toHaveLength(1);
    evaluate(s,{...frame(2,200,{usd:0.2}),healthy:["D1"],errors:["Workers unavailable"]},base+2*WINDOW_MS);
    run(s,3,200,{usd:0.2});expect(s.outbox).toEqual([]);
    run(s,4,200,{usd:0.2});expect(s.outbox).toEqual([]);
    run(s,5,200,{usd:0.2});expect(s.outbox.find(n=>n.key==='account:burn')?.severity).toBe(2);
    ack(s,5);
    run(s,8,200,{usd:0.2});run(s,9,200,{usd:0.2});
    expect(s.metrics['account:burn'].severity).toBe(2);
    expect(s.outbox).toEqual([]);
  });
  it("recovers an active burn after two observed low windows without waiting for the long average",()=>{
    const s=emptyState();run(s,1,200,{usd:2});ack(s,1);
    run(s,2);expect(s.outbox).toEqual([]);
    run(s,3);expect(s.outbox.find(n=>n.key==='account:burn')?.kind).toBe("recovery");
  });
  it("does not let optional diagnostic failure or billing unavailability invalidate covered core costs",()=>{
    const s=emptyState();evaluate(s,{...frame(1,200,{usd:2}),costComplete:true,errors:["Billing unavailable"],diagnostics:["SQL unavailable"]},base+WINDOW_MS);
    expect(s.metrics['account:burn'].severity).toBe(2);
    const other=emptyState();evaluate(other,{...frame(1,200,{usd:2}),costComplete:false,errors:["R2 storage unavailable"]},base+WINDOW_MS);
    expect(other.metrics['account:burn']).toBeUndefined();
  });
  it("turns explicit incomplete cost coverage into a collection gap even when the source omitted an error",()=>{
    const s=emptyState();run(s,1);const lastSuccess=s.lastSuccess;
    const incomplete={...frame(2,200,{usd:2}),costComplete:false};evaluate(s,incomplete,base+2*WINDOW_MS);
    expect(incomplete.errors).toEqual(["Monitor: consumption coverage incomplete"]);
    expect(s.lastSuccess).toBe(lastSuccess);expect(s.lastError).toContain("coverage incomplete");
    expect(s.metrics['account:burn'].lastSeen).toBe(base+WINDOW_MS);
  });
  it("does not price a missing known storage snapshot as zero or recover account burn from it",()=>{
    const s=emptyState(),key="R2:bucket:storage:Standard";
    const storage={...frame(1).points[0],key,product:"R2" as const,resource:"bucket",label:"storage",amount:1e9,operations:1,efficiency:undefined,efficiencyWarning:undefined,efficiencyCritical:undefined,gauge:true,usd:2};
    const first=frame(1);first.points.push(storage);evaluate(s,first,base+WINDOW_MS);ack(s,1);
    const windows=structuredClone(s.metrics['account:burn'].burnWindows),lastSuccess=s.lastSuccess,storageExpiry=s.metrics[key].expiresAt;
    for(let i=2;i<=3;i++){
      const missing=frame(i);evaluate(s,missing,base+i*WINDOW_MS);
      expect(missing.costComplete).toBe(false);
      expect(missing.errors).toContain("R2 storage: known snapshot missing; coverage incomplete");
    }
    expect(s.metrics['account:burn'].severity).toBe(2);expect(s.metrics['account:burn'].burnWindows).toEqual(windows);
    expect(s.lastSuccess).toBe(lastSuccess);expect(s.metrics[key].expiresAt).toBe(storageExpiry);expect(s.outbox).toEqual([]);
    for(let i=4;i<=5;i++){
      const complete=frame(i);complete.points.push({...storage,usd:0.01});evaluate(s,complete,base+i*WINDOW_MS);
    }
    expect(s.metrics['account:burn'].severity).toBe(0);expect(s.lastSuccess).toBe(base+5*WINDOW_MS);
  });
  it("expires a disappeared storage gauge at its original TTL so a deleted bucket cannot block coverage forever",()=>{
    const s=emptyState(),key="R2:deleted:storage:Standard";
    run(s,1,200,{key,product:"R2",resource:"deleted",gauge:true,usd:0.01});
    const next=base+WINDOW_MS+STATE_TTL_MS,at=next+WINDOW_MS;
    const f:Frame={at,points:[],healthy:["D1","Workers","R2","KV","DO","Queues"],errors:[]};evaluate(s,f,at);
    expect(s.metrics[key]).toBeUndefined();expect(f.errors).toEqual([]);expect(s.lastSuccess).toBe(at);
  });
  it("applies the cost floor to relative SQL spikes and confirms absolute diagnostics twice",()=>{
    const s=emptyState();const extra={key:"D1:core:sql-fingerprint",diagnostic:true,efficiencyWarning:undefined,efficiencyCritical:undefined,minAmount:1};
    for(let i=1;i<=20;i++)run(s,i,20,{...extra,usd:1e-6});
    run(s,21,2000,{...extra,usd:1e-5});run(s,22,2000,{...extra,usd:1e-5});
    expect(s.outbox).toEqual([]);
    const absolute=emptyState();run(absolute,1,380_000,{diagnostic:true});expect(absolute.outbox).toEqual([]);
    run(absolute,2,380_000,{diagnostic:true});expect(absolute.outbox[0].severity).toBe(2);
  });
  it("bounds cardinality and rejects NaN/duplicate telemetry",()=>{
    const s=emptyState();run(s,1);const existing=s.metrics['D1:core:read'];
    for(let i=0;Object.keys(s.metrics).length<MAX_METRICS;i++)s.metrics[`D1:x:${i}`]={...existing,severity:2};
    for(const m of Object.values(s.metrics))m.severity=2; // every slot is an open incident: nothing may be evicted
    expect(()=>run(s,2,200,{key:"D1:new:read"})).toThrow("cardinality");
    expect(()=>run(emptyState(),1,NaN)).toThrow();
    const f=frame(1);f.points.push({...f.points[0]});expect(()=>evaluate(emptyState(),f,base)).toThrow();
  });
  it("evicts quiet metrics when full instead of failing every collection",()=>{
    // Production: SQL fingerprints and new Workers keep adding keys; every
    // remembered metric also gets a synthetic "stopped" zero point, so the
    // full state used to have no eviction candidate and each tick threw.
    const s=emptyState();run(s,1);const existing=s.metrics['D1:core:read'];
    for(let i=0;Object.keys(s.metrics).length<MAX_METRICS;i++)s.metrics[`D1:x:${i}`]={...existing,lastSeen:base+i};
    expect(()=>run(s,2,200,{key:"D1:new:read"})).not.toThrow();
    expect(s.metrics['D1:new:read']).toBeDefined();
    expect(s.metrics['D1:x:0']).toBeUndefined(); // least recently seen goes first
    expect(Object.keys(s.metrics).length).toBeLessThanOrEqual(MAX_METRICS);
    expect(()=>run(s,3,200,{key:"D1:newer:read"})).not.toThrow();
  });
  it("expires metric state, pending notices and delivery receipts",()=>{
    const s=emptyState();run(s,1,380_000);ack(s,1);compact(s,base+WINDOW_MS+STATE_TTL_MS+1);
    expect(Object.keys(s.metrics)).toHaveLength(0);expect(s.outbox).toHaveLength(0);expect(s.recentDelivery).toHaveLength(0);
  });
  it("migrates old SQL-saturated state so core alerts can resume without a storage reset",()=>{
    const s=emptyState();run(s,1,380_000);const existing=s.metrics['D1:core:read'];
    s.metrics={};s.outbox=[];
    for(let i=0;i<MAX_METRICS;i++){
      const key=`D1:core:sql-${i}`;
      s.metrics[key]={...existing,diagnostic:true,lastSeen:base+i};
      if(i<64)s.outbox.push({id:key,key,kind:"open",severity:2,text:"old SQL diagnostic",delivered:[],attempts:0,expiresAt:base+STATE_TTL_MS});
    }
    expect(()=>run(s,2,380_000)).not.toThrow();
    expect(Object.values(s.metrics).filter(m=>m.diagnostic).length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_METRICS);
    expect(s.outbox.some(n=>n.key==='D1:core:read')).toBe(true);
    expect(s.outbox.filter(n=>s.metrics[n.key]?.diagnostic).length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_NOTICES);
  });
  it("keeps core slots and bounded notices when many SQL fingerprints are anomalous together",()=>{
    const s=emptyState();
    const make=(i:number):Frame=>({...frame(i),completeQueries:true,points:Array.from({length:96},(_,n)=>({...frame(i,380_000).points[0],key:`D1:core:sql-${n}`,diagnostic:true}))});
    evaluate(s,make(1),base+WINDOW_MS);const second=make(2);evaluate(s,second,base+2*WINDOW_MS);
    expect(s.outbox).toHaveLength(MAX_DIAGNOSTIC_NOTICES);
    expect(second.diagnostics?.join(" ")).toContain("state limited");expect(second.completeQueries).toBe(false);
    expect(()=>run(s,3,380_000)).not.toThrow();
    expect(s.outbox.find(n=>n.key==='D1:core:read')?.severity).toBe(2);
    expect(new TextEncoder().encode(JSON.stringify(s)).byteLength).toBeLessThan(MAX_STATE_BYTES);
  });
  it("evicts an active optional diagnostic when every metric slot is occupied",()=>{
    const s=emptyState();run(s,1,380_000);const existing=s.metrics['D1:core:read'];s.metrics={};s.outbox=[];
    for(let i=0;i<MAX_METRICS;i++)s.metrics[`Workers:busy-${i}:cpu`]={...existing,diagnostic:i===0};
    evaluate(s,{...frame(2,380_000),healthy:[]},base+2*WINDOW_MS);
    expect(s.metrics['Workers:busy-0:cpu']).toBeUndefined();expect(s.metrics['D1:core:read'].severity).toBe(2);
    expect(Object.keys(s.metrics)).toHaveLength(MAX_METRICS);
  });
});
