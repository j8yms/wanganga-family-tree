const API_URL = "https://script.google.com/macros/s/AKfycbxxgjND3ex5xTp3eUV8uCX6XAwtWax4EZ2tHpeOcVx80tZMx7IMXLyWFzZ7qfRBK0gEqA/exec";
const fs = require("fs");
let ids = {};
try { ids = JSON.parse(fs.readFileSync("person_ids.json", "utf8")); } catch (e) {}

const spousePairs = [
  { primary: "Mwangi Kiama", ghost: "Wanjiku Mwangi" },
  { primary: "Njoroge Mwangi", ghost: "Wambui Njoroge" },
  { primary: "Kamau Njoroge", ghost: "Njeri Kamau" },
  { primary: "Thiong'o Kamau", ghost: "Wanjiku Thiong'o" },
  { primary: "Maina Thiong'o", ghost: "Wairimu Maina" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(action, params = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(`${API_URL}?${qs}`);
  return res.json();
}

async function post(payload) {
  const res = await fetch(API_URL, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "text/plain" },
  });
  return res.json();
}

async function main() {
  // Re-fetch IDs from the live sheet so keys are always fresh
  const data = await get("getAll");
  const byName = {};
  data.persons.forEach(p => {
    byName[`${p.gikuyu_name} ${p.fathers_name}`] = p.person_id;
  });

  let created = 0, skipped = 0;
  for (const pair of spousePairs) {
    const pid = byName[pair.primary];
    const sid = byName[pair.ghost];
    if (!pid || !sid) { console.log(`MISSING ids for ${pair.primary} / ${pair.ghost}`); continue; }

    // Skip if already linked as spouses
    const exists = data.relationships.some(r =>
      (String(r.parent_id) === String(pid) && String(r.child_id) === String(sid)) ||
      (String(r.parent_id) === String(sid) && String(r.child_id) === String(pid))
    );
    if (exists) { console.log(`Already linked: ${pair.primary} <-> ${pair.ghost}`); skipped++; continue; }

    const res = await post({
      action: "createRelationship",
      parent_id: pid,
      child_id: sid,
      rel_type: "Spouse",
    });
    if (res.success) { created++; console.log(`Spouse link: ${pair.primary} <-> ${pair.ghost}`); }
    else console.log(`FAILED ${pair.primary}: ${res.error}`);
    await sleep(400);
  }

  console.log(`\n${created} new spouse links, ${skipped} already existed`);
}

main();