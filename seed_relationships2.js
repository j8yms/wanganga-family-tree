const API_URL = "https://script.google.com/macros/s/AKfycbxxgjND3ex5xTp3eUV8uCX6XAwtWax4EZ2tHpeOcVx80tZMx7IMXLyWFzZ7qfRBK0gEqA/exec";
const fs = require("fs");
const ids = JSON.parse(fs.readFileSync("person_ids.json", "utf8"));

const relations = [
  { parent: "Wanjiku Thiong'o", child: "Githinji Wanjiku", rel_type: "Mother-Child" },
  { parent: "Thiong'o Kamau", child: "Mumbi Wanjiku", rel_type: "Father-Child" },
  { parent: "Wanjiku Thiong'o", child: "Mumbi Wanjiku", rel_type: "Mother-Child" },
  { parent: "Maina Thiong'o", child: "Kibaki Maina", rel_type: "Father-Child" },
  { parent: "Wairimu Maina", child: "Kibaki Maina", rel_type: "Mother-Child" },
  { parent: "Kibaki Maina", child: "Njoki Kibaki", rel_type: "Father-Child" },
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
    const result = await post({
      action: "createRelationship",
      parent_id: ids[r.parent],
      child_id: ids[r.child],
      rel_type: r.rel_type,
    });
    if (result.success) {
      ok++;
      console.log(`Linked: ${r.parent} -> ${r.child} (${r.rel_type})`);
    } else {
      console.log(`FAILED: ${r.parent} -> ${r.child} - ${result.error}`);
    }
    await sleep(400);
  }
  console.log(`\n${ok}/7 created in this run`);
}

main();