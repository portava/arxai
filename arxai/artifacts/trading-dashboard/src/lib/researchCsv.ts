/** Small bounded RFC4180-style import; preserve quoted commas/newlines. */
export function readResearchCsv(text:string):Record<string,string>[] {
  if(text.length>500_000)throw new Error("CSV must be smaller than 500 KB");
  const rows:string[][]=[];let row:string[]=[],cell="",quoted=false,closed=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
    if(c==='"'){if(cell || closed)throw new Error("Malformed CSV quote");quoted=true;continue;}
    if(c===','||c==='\n'||c==='\r'){
      row.push(cell);cell="";closed=false;
      if(c!==','){if(c==='\r'&&text[i+1]==='\n')i++;if(row.some(v=>v.trim()))rows.push(row);row=[];}
    }else{if(closed && c.trim())throw new Error("Unexpected text after quoted CSV cell");if(!closed)cell+=c;}
  }
  if(quoted)throw new Error("Unclosed CSV quote");
  row.push(cell);if(row.some(v=>v.trim()))rows.push(row);
  if(rows.length<2 || rows.length>1001)throw new Error("CSV needs a header and 1–1000 data rows");
  const headers=rows.shift()!.map(s=>s.replace(/^\uFEFF/,"").trim());
  if(headers.some(h=>!h || ["__proto__","constructor","prototype"].includes(h))||new Set(headers).size!==headers.length)throw new Error("CSV headers must be unique and named");
  return rows.map((r,i)=>{if(r.length!==headers.length)throw new Error(`CSV row ${i+2} has the wrong number of columns`);return Object.fromEntries(headers.map((h,j)=>[h,r[j].trim()]));});
}
export function csvNumber(value:string|undefined):number {
  if(value===undefined||!value.trim())throw new Error("A required number is missing");
  const n=Number(value);if(!Number.isFinite(n))throw new Error(`Invalid number: ${value.slice(0,40)}`);return n;
}
