// Per-route entry JS (client reference manifest entryJSFiles), raw/gzip/brotli. Run from apps/mercato/.mercato/next.
// Usage: node entry.js [--json out.json]
const fs=require("fs"),zlib=require("zlib");
const files=require("child_process").execSync("find server/app -name page_client-reference-manifest.js").toString().trim().split("\n").sort();
const out={};
for(const f of files){ globalThis.__RSC_MANIFEST={}; eval(fs.readFileSync(f,"utf8")); const m=Object.values(globalThis.__RSC_MANIFEST)[0]; const ent=m.entryJSFiles||{}; const all=new Set(); for(const k in ent) for(const x of ent[k]) all.add(x);
 let raw=0,gz=0,br=0; for(const x of all){const b=fs.readFileSync(x); raw+=b.length; gz+=zlib.gzipSync(b,{level:9}).length; if(!process.env.NOBR) br+=zlib.brotliCompressSync(b).length}
 const route=(f.replace("server/app","").replace("/page_client-reference-manifest.js","")||"/");
 out[route]={files:all.size,raw,gz,br};
 console.log(route.padEnd(60), String(all.size).padStart(3), (raw/1e6).toFixed(2)+" MB raw", (gz/1e6).toFixed(2)+" MB gz", (br/1e6).toFixed(2)+" MB br") }
const i=process.argv.indexOf("--json"); if(i>0) fs.writeFileSync(process.argv[i+1], JSON.stringify(out,null,1));
