const API_URL = "https://script.google.com/macros/s/AKfycbxxgjND3ex5xTp3eUV8uCX6XAwtWax4EZ2tHpeOcVx80tZMx7IMXLyWFzZ7qfRBK0gEqA/exec";
const fs = require("fs");

const ids = JSON.parse(fs.readFileSync("person_ids.json", "utf8"));

const relations = [
  // Mwangi (John) & Wanjiku (Mary) -> Njoroge (James)
  { parent: "Mwangi Kiama", child: "Njoroge Mwangi", rel_type: "Father-Child" },
  { parent: "Wanjiku Mwangi", child: "Njoroge Mwangi", rel_type: "Mother-Child" },
  // Njoroge (James) & Wambui (Grace) -> Kamau (Peter)
  { parent: "Njoroge Mwangi", child: "Kamau Njoroge", rel_type: "Father-Child" },
  { parent: "Wambui Njoroge", child: "Kamau Njoroge", rel_type: "Mother-Child" },
  // Kamau (Peter) & Njeri (Agnes) -> Thiong'o (Daniel)
  { parent: "Kamau Njoroge", child: "Thiong'o Kamau", rel_type: "Father-Child" },
  { parent: "Njeri Kamau", child: "Thiong'o Kamau", rel_type: "Mother-Child" },
  // Thiong'o (Daniel) & Wanjiku (Sarah) -> Maina (David)
  { parent: "Thiong'o Kamau", child: "Maina Thiong'o", rel_type: "Father-Child" },
  { parent: "Wanjiku Thiong'o", child: "Maina Thiong'o", rel_type: "Mother-Child" },
  // Thiong'o (Daniel) & Wanjiku (Sarah) -> Githinji (Brian)
  { parent: "Thiong'o Kamau", child: "Githinji Wanjiku", rel_type: "Father-Child" },
  { parent: "Wanjiku Thiong'o", child: "Githinji Wanjiku", rel_type: "Mother-Child" },
  // Thiong'o (Daniel) & Wanjiku (Sarah) -> Mumbi (Alice)
  { parent: "Thiong'o Kamau", child: "Mumbi Wanjiku", rel_type: "Father-Child" },
  { parent: "Wanjiku Thiong'o", child: "Mumbi Wanjiku", rel_type: "Mother-Child" },
  // Maina (David) & Wairimu (Joyce) -> Kibaki (Kevin)
  { parent: "Maina Thiong'o", child: "Kibaki Maina", rel_type: "Father-Child" },
  { parent: "Wairimu Maina", child: "Kibaki Maina", rel_type: "Mother-Child" },
  // Kibaki (Kevin) -> Njoki (Linda)
  { parent: "Kibaki Maina", child: "Njoki Kibaki", rel_type: "Father-Child" },
  // Kibaki (Kevin) -> Muthoni (Faith)
  { parent: "Kibaki Maina", child: "Muthoni Kibaki", rel_type: "Father-Child" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(payload) {
  const res = await fetch(API_URL, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "text/plain" },
  });
  return res.json();
}

async function main() {
  let ok = 0;
  for (const r of relations) {
    const parentId = ids[r.parent];
    const childId = ids[r.child];
    if (!parentId || !childId) {
      console.log(`MISSING ID for ${r.parent} -> ${r.child}`);
      continue;
    }
    try {
      const result = await post({
        action: "createRelationship",
        parent_id: parentId,
        child_id: childId,
        rel_type: r.rel_type,
      });
      if (result.success) {
        ok++;
        console.log(`Linked: ${r.parent} -> ${r.child} (${r.rel_type})`);
      } else {
        console.log(`FAILED: ${r.parent} -> ${r.child} - ${result.error}`);
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
    await sleep(400);
  }
  console.log(`\n${ok}/${relations.length} relationships created`);
}

main();