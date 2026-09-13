const fs = require("fs");
const path = require("path");
const { post } = require("./api");

const persons = [
  { gikuyu_name: "Mwangi", fathers_name: "Kiama", other_names: "John", gender: "Male", is_living: false, birth_year: "1920" },
  { gikuyu_name: "Wanjiku", fathers_name: "Mwangi", other_names: "Mary", gender: "Female", is_living: false, birth_year: "1925" },
  { gikuyu_name: "Njoroge", fathers_name: "Mwangi", other_names: "James", gender: "Male", is_living: false, birth_year: "1945" },
  { gikuyu_name: "Wambui", fathers_name: "Njoroge", other_names: "Grace", gender: "Female", is_living: false, birth_year: "1948" },
  { gikuyu_name: "Kamau", fathers_name: "Njoroge", other_names: "Peter", gender: "Male", is_living: true, birth_year: "1950" },
  { gikuyu_name: "Njeri", fathers_name: "Kamau", other_names: "Agnes", gender: "Female", is_living: true, birth_year: "1955" },
  { gikuyu_name: "Thiong'o", fathers_name: "Kamau", other_names: "Daniel", gender: "Male", is_living: true, birth_year: "1970" },
  { gikuyu_name: "Wanjiku", fathers_name: "Thiong'o", other_names: "Sarah", gender: "Female", is_living: true, birth_year: "1975" },
  { gikuyu_name: "Maina", fathers_name: "Thiong'o", other_names: "David", gender: "Male", is_living: true, birth_year: "1972" },
  { gikuyu_name: "Wairimu", fathers_name: "Maina", other_names: "Joyce", gender: "Female", is_living: true, birth_year: "1978" },
  { gikuyu_name: "Kibaki", fathers_name: "Maina", other_names: "Kevin", gender: "Male", is_living: true, birth_year: "1980" },
  { gikuyu_name: "Njoki", fathers_name: "Kibaki", other_names: "Linda", gender: "Female", is_living: true, birth_year: "2005" },
  { gikuyu_name: "Muthoni", fathers_name: "Kibaki", other_names: "Faith", gender: "Female", is_living: true, birth_year: "2008" },
  { gikuyu_name: "Githinji", fathers_name: "Wanjiku", other_names: "Brian", gender: "Male", is_living: true, birth_year: "1998" },
  { gikuyu_name: "Mumbi", fathers_name: "Wanjiku", other_names: "Alice", gender: "Female", is_living: true, birth_year: "2001" },
];

async function main() {
  const ids = {};

  for (const p of persons) {
    const key = `${p.gikuyu_name} ${p.fathers_name}`;
    try {
      const result = await post({ action: "createPerson", ...p });
      if (result.success) {
        ids[key] = result.person_id;
        console.log(`Created: ${key} -> ${result.person_id}`);
      } else {
        console.log(`FAILED: ${key} - ${result.error}`);
      }
    } catch (err) {
      console.log(`ERROR creating ${key}: ${err.message}`);
    }
  }

  const outFile = path.join(__dirname, "..", "person_ids.json");
  fs.writeFileSync(outFile, JSON.stringify(ids, null, 2));
  console.log(`\nIDs saved to ${outFile}`);
  console.log(JSON.stringify(ids, null, 2));
}

main();