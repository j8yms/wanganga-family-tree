$apiUrl = "https://script.google.com/macros/s/AKfycbyK7Q4PGh6jSmNgN1NaBlgJnj-IkkduiqleToZjC7F2vGodtGO9RjN498QGvrgf1xykjw/exec"

$persons = @(
    @{ gikuyu_name="Mwangi"; fathers_name="Kiama"; other_names="John"; gender="Male"; is_living=$false; birth_year="1920" },
    @{ gikuyu_name="Wanjiku"; fathers_name="Mwangi"; other_names="Mary"; gender="Female"; is_living=$false; birth_year="1925" },
    @{ gikuyu_name="Njoroge"; fathers_name="Mwangi"; other_names="James"; gender="Male"; is_living=$false; birth_year="1945" },
    @{ gikuyu_name="Wambui"; fathers_name="Njoroge"; other_names="Grace"; gender="Female"; is_living=$false; birth_year="1948" },
    @{ gikuyu_name="Kamau"; fathers_name="Njoroge"; other_names="Peter"; gender="Male"; is_living=$true; birth_year="1950" },
    @{ gikuyu_name="Njeri"; fathers_name="Kamau"; other_names="Agnes"; gender="Female"; is_living=$true; birth_year="1955" },
    @{ gikuyu_name="Thiong'o"; fathers_name="Kamau"; other_names="Daniel"; gender="Male"; is_living=$true; birth_year="1970" },
    @{ gikuyu_name="Wanjiku"; fathers_name="Thiong'o"; other_names="Sarah"; gender="Female"; is_living=$true; birth_year="1975" },
    @{ gikuyu_name="Maina"; fathers_name="Thiong'o"; other_names="David"; gender="Male"; is_living=$true; birth_year="1972" },
    @{ gikuyu_name="Wairimu"; fathers_name="Maina"; other_names="Joyce"; gender="Female"; is_living=$true; birth_year="1978" },
    @{ gikuyu_name="Kibaki"; fathers_name="Maina"; other_names="Kevin"; gender="Male"; is_living=$true; birth_year="1980" },
    @{ gikuyu_name="Njoki"; fathers_name="Kibaki"; other_names="Linda"; gender="Female"; is_living=$true; birth_year="2005" },
    @{ gikuyu_name="Muthoni"; fathers_name="Kibaki"; other_names="Faith"; gender="Female"; is_living=$true; birth_year="2008" },
    @{ gikuyu_name="Githinji"; fathers_name="Wanjiku"; other_names="Brian"; gender="Male"; is_living=$true; birth_year="1998" },
    @{ gikuyu_name="Mumbi"; fathers_name="Wanjiku"; other_names="Alice"; gender="Female"; is_living=$true; birth_year="2001" }
)

$names = $persons | ForEach-Object { "$($_.gikuyu_name) $($_.fathers_name)" }

$ids = @{}

for ($i = 0; $i -lt $persons.Count; $i++) {
    $person = $persons[$i]
    $json = '{"action":"createPerson","gikuyu_name":"' + $person.gikuyu_name + '","fathers_name":"' + $person.fathers_name + '","other_names":"' + $person.other_names + '","gender":"' + $person.gender + '","is_living":' + ($person.is_living.ToString().ToLower()) + ',"birth_year":"' + $person.birth_year + '"}'
    
    try {
        $tempFile = [System.IO.Path]::GetTempFileName()
        [System.IO.File]::WriteAllText($tempFile, $json, [System.Text.Encoding]::UTF8)
        $response = curl.exe -s -X POST -H "Content-Type: text/plain" --data-binary "@$tempFile" $apiUrl
        Remove-Item $tempFile -ErrorAction SilentlyContinue
        
        $result = $response | ConvertFrom-Json
        if ($result.success) {
            $ids[$names[$i]] = $result.person_id
            Write-Host "Created: $($names[$i]) -> $($result.person_id)"
        } else {
            Write-Host "FAILED: $($names[$i]) - $($result.error)"
        }
    } catch {
        Write-Host "ERROR creating $($names[$i]): $_"
    }
    Start-Sleep -Milliseconds 800
}

Write-Host "`n=== ALL PERSON IDS ==="
$ids.GetEnumerator() | ForEach-Object { Write-Host "$($_.Key) = $($_.Value)" }

$outFile = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\person_ids.json"
$ids | ConvertTo-Json | Out-File -FilePath $outFile -Encoding UTF8
Write-Host "`nIDs saved to $outFile"