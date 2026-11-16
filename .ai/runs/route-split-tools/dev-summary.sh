#!/bin/bash
cd /Volumes/CaseSensitive/repos/open-mercato
node -e '
const o=require("./.ai/runs/route-split-logs/'$1'-dev-measure.json");
console.log("start",o.rssAtStartMb,"peakDuringRun",o.rssPeakDuringRunMb,"login",JSON.stringify(o.login));
for(const h of o.hits) console.log(h.path,h.status,h.ms+"ms","peak",h.rssPeakMb,"after",h.rssAfterMb);
for(const e of o.compile.filter(e=>e.name==="compile-path"&&e.ms>300)) console.log(e.name,e.ms,JSON.stringify(e.tags));
console.log("end",o.rssEndMb)'
