import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useWikiStore } from "../stores/wiki";
import { getCards } from "../lib/api";
import type { ModuleCard } from "../lib/api";

export default function CardsView() {
  const { id } = useParams<{ id: string }>();
  const [cards, setCards] = useState<ModuleCard[] | null>(null);
  const [projectName, setProjectName] = useState("");
  const navigate = useNavigate();
  const setCurrentPage = useWikiStore((s) => s.setCurrentPage);

  const openModule = (pageId: string) => {
    // the wiki view reads the persisted currentPageId, so set it before routing
    setCurrentPage(pageId);
    navigate(`/project/${id}`);
  };
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    getCards(id).then((r) => {
      if (!r || r.error) setError(r?.error ?? "failed to load knowledge cards");
      else {
        setCards(r.cards);
        setProjectName(r.project_name);
      }
    });
  }, [id]);

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <div className="px-6 py-3 border-b border-slate-200 flex items-center gap-4">
        <Link to={`/project/${id}`} className="text-sm text-slate-500 hover:text-slate-700">
          ← wiki
        </Link>
        <Link to={`/project/${id}/map`} className="text-sm text-slate-500 hover:text-slate-700">
          repo map
        </Link>
        <Link to={`/project/${id}/diff`} className="text-sm text-slate-500 hover:text-slate-700">
          diff review
        </Link>
        <span className="text-sm font-medium text-slate-800">Knowledge Cards</span>
        {cards && (
          <span className="text-xs text-slate-400">
            {projectName} · {cards.length} modules · pick a card, then open the full module page
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : !cards ? (
          <p className="text-sm text-slate-400 animate-pulse">Loading cards...</p>
        ) : cards.length === 0 ? (
          <p className="text-sm text-slate-500">
            No knowledge cards: the wiki analysis produced no modules with a purpose or files.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {cards.map((c) => (
              <div
                key={c.name}
                className="border border-slate-200 rounded-lg p-4 flex flex-col gap-2 hover:border-slate-300 hover:shadow-sm transition"
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    onClick={() => openModule(c.page_id)}
                    className="font-mono text-sm font-semibold text-slate-800 hover:text-blue-600 truncate text-left"
                  >
                    {c.name}
                  </button>
                  {c.in_cycle && (
                    <span
                      title="Files in this module import each other in a loop; read them as a set"
                      className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5"
                    >
                      cycle
                    </span>
                  )}
                </div>

                {c.purpose && (
                  <p className="text-sm text-slate-600 leading-snug line-clamp-3">{c.purpose}</p>
                )}

                <div className="text-xs text-slate-500 flex flex-wrap gap-x-2 gap-y-1">
                  {c.file_count > 0 && <span>{c.file_count} files</span>}
                  {c.key_symbols.length > 0 && (
                    <span>
                      symbols{" "}
                      {c.key_symbols.map((s) => (
                        <code key={s} className="px-1 bg-slate-100 rounded text-slate-700 mr-1">
                          {s}
                        </code>
                      ))}
                      {c.extra_symbols > 0 && <span>+{c.extra_symbols} more</span>}
                    </span>
                  )}
                  {c.key_concepts.length > 0 && <span>concepts {c.key_concepts.join(", ")}</span>}
                </div>

                {c.entry_files.length > 0 && (
                  <div className="text-xs text-slate-500">
                    Entry:{" "}
                    {c.entry_files.map((f) => (
                      <code key={f} className="px-1 bg-slate-100 rounded text-slate-700 mr-1">
                        {f}
                      </code>
                    ))}
                    {c.extra_entries > 0 && <span>+{c.extra_entries} more</span>}
                  </div>
                )}

                {c.hotspots.length > 0 && (
                  <div className="text-xs text-slate-500">
                    Hot:{" "}
                    {c.hotspots.map(([p, n]) => (
                      <span key={p} className="mr-2">
                        <code className="px-1 bg-slate-100 rounded text-slate-700">{p}</code> ({n})
                      </span>
                    ))}
                  </div>
                )}

                {c.relationships.length > 0 && (
                  <div className="text-xs text-slate-400">
                    {c.relationships.map(([s, t]) => `${s} → ${t}`).join(" · ")}
                  </div>
                )}

                <div className="mt-auto pt-2">
                  <button
                    onClick={() => openModule(c.page_id)}
                    className="text-xs text-blue-600 hover:underline text-left"
                  >
                    Open the full page →
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
