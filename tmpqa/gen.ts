import { buildJobsPdf } from "../src/lib/jobs-pdf";
const mk = (i:number)=>({
  patient:{id:String(i),full_name:`AB${i}`,age:60+i,sex:i%2?"male":"female",hospital_number:`RH${100000+i}`,bed:`${i}`},
  tasks:[
    {id:"a"+i,description:"Repeat ABG at 14:00 and adjust ventilation as needed for persistent respiratory acidosis",status:"not_started",priority:"urgent",category:"ward_round",owner:"SHO",due_at:new Date(Date.now()-3600e3).toISOString(),notes:"Discussed with consultant on the round; escalate PEEP if pH < 7.25 and inform the intensivist."},
    {id:"b"+i,description:"Chase microbiology",status:"in_progress",priority:"routine",category:"job",owner:null,due_at:new Date(Date.now()+3600e3).toISOString(),notes:null},
    {id:"c"+i,description:"Family update",status:"completed",priority:"critical",category:"job",owner:"Reg",due_at:null,notes:"NOK called"},
  ] as any,
});
const doc = buildJobsPdf([mk(1),mk(2),mk(3),mk(4),mk(5),mk(6)],{subtitle:"Open jobs only · 12 open across the unit"});
const buf = Buffer.from(doc.output("arraybuffer"));
await Bun.write("/tmp/qa/jobs.pdf", buf);
console.log("ok", buf.length);
