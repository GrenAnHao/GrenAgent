import json, urllib.request, urllib.parse, sys

def fetch(url):
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "pi-agent/1.0"
    })
    return json.load(urllib.request.urlopen(req, timeout=15))

# Search for top AI repos this week
results = {}
queries = {
    "ai": "ai stars:>100",
    "llm": "llm stars:>100",
    "agent": "ai-agent stars:>50",
}

for label, q in queries.items():
    try:
        url = f"https://api.github.com/search/repositories?q={urllib.parse.quote(q)}&sort=stars&order=desc&per_page=5"
        data = fetch(url)
        results[label] = data["items"]
        print(f"[{label}] Found {data['total_count']} total, showing {len(data['items'])}", file=sys.stderr)
    except Exception as e:
        print(f"[{label}] Error: {e}", file=sys.stderr)
        results[label] = []

print("=== GITHUB AI TRENDING REPOSITORIES ===")
print(f"Date: 2026-06-14")
print()

seen_ids = set()
all_repos = []
for label, items in results.items():
    for item in items:
        if item["id"] not in seen_ids:
            seen_ids.add(item["id"])
            all_repos.append(item)

all_repos.sort(key=lambda x: x["stargazers_count"], reverse=True)

for i, repo in enumerate(all_repos[:20], 1):
    lang = repo.get("language") or "-"
    desc = (repo.get("description") or "No description").strip()
    topics = repo.get("topics", [])
    print(f"#{i}")
    print(f"  Repo:    {repo['full_name']}")
    print(f"  Stars:   {repo['stargazers_count']:,}")
    print(f"  Forks:   {repo['forks_count']:,}")
    print(f"  Lang:    {lang}")
    print(f"  Desc:    {desc[:150]}")
    if topics:
        print(f"  Topics:  {', '.join(topics[:8])}")
    print(f"  URL:     {repo['html_url']}")
    print()
