import json, urllib.request, urllib.parse, sys

def fetch(url):
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "pi-agent/1.0"
    })
    return json.load(urllib.request.urlopen(req, timeout=15))

# Get repos created recently with high growth
# Using pushed/created this week with AI topics
queries = {
    "new_ai": "ai created:>=2026-06-10 sort:stars",
    "trending_ai": "ai pushed:>=2026-06-12 sort:stars",
    "new_llm": "llm created:>=2026-06-10 sort:stars",
}

results = {}
for label, q in queries.items():
    try:
        url = f"https://api.github.com/search/repositories?q={urllib.parse.quote(q)}&per_page=10"
        data = fetch(url)
        results[label] = data["items"]
        print(f"[{label}] Found {data['total_count']} total, showing {len(data['items'])}", file=sys.stderr)
    except Exception as e:
        print(f"[{label}] Error: {e}", file=sys.stderr)
        results[label] = []

print("\n=== TODAY'S HOT AI REPOS (Recent/Pushed This Week) ===")
print("Date: 2026-06-14")
print()

seen_ids = set()
all_repos = []
for label, items in results.items():
    for item in items:
        if item["id"] not in seen_ids:
            seen_ids.add(item["id"])
            all_repos.append(item)

all_repos.sort(key=lambda x: x["stargazers_count"], reverse=True)

for i, repo in enumerate(all_repos[:15], 1):
    lang = repo.get("language") or "-"
    desc = (repo.get("description") or "No description").strip()
    topics = repo.get("topics", [])
    created = repo["created_at"][:10]
    updated = repo["updated_at"][:10]
    print(f"#{i}")
    print(f"  Repo:    {repo['full_name']}")
    print(f"  Stars:   {repo['stargazers_count']:,}")
    print(f"  Forks:   {repo['forks_count']:,}")
    print(f"  Lang:    {lang}")
    print(f"  Created: {created} | Updated: {updated}")
    print(f"  Desc:    {desc[:150]}")
    if topics:
        print(f"  Topics:  {', '.join(topics[:8])}")
    print(f"  URL:     {repo['html_url']}")
    print()
