import { useEffect, useState } from "react";
import "./PlanEditor.css";
type PagePlan = {
  id: string;
  title: string;
  goal: string;
  patterns: string[];
  depends_on: string[];
};
type Plan = {
  include?: string[];
  exclude?: string[];
  pages?: PagePlan[];
  [key: string]: unknown;
};
const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
function PatternInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value.join("\n"));
  const canonical = value.join("\n");
  useEffect(() => {
    if (lines(draft).join("\n") !== canonical) setDraft(canonical);
  }, [canonical]);
  return (
    <textarea
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(lines(event.target.value));
      }}
    />
  );
}
export function PlanEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  let plan: Plan | null = null;
  try {
    const parsed = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      ["include", "exclude", "pages"].every(
        (key) => parsed[key] === undefined || Array.isArray(parsed[key]),
      ) &&
      (!parsed.pages ||
        parsed.pages.every(
          (p: unknown) =>
            p &&
            typeof p === "object" &&
            typeof (p as PagePlan).id === "string",
        ))
    )
      plan = parsed;
  } catch {}
  const update = (next: Plan) => onChange(JSON.stringify(next, null, 2));
  const editPage = (index: number, field: keyof PagePlan, next: unknown) => {
    if (plan)
      update({
        ...plan,
        pages: (plan.pages || []).map((page, i) =>
          i === index ? { ...page, [field]: next } : page,
        ),
      });
  };
  return (
    <div className="plan-workspace">
      <div className="plan-mode-tabs" role="group" aria-label="计划编辑模式">
        <button
          type="button"
          aria-pressed={!advanced}
          onClick={() => setAdvanced(false)}
        >
          生成范围与页面
        </button>
        <button
          type="button"
          aria-pressed={advanced}
          onClick={() => setAdvanced(true)}
        >
          高级 JSON
        </button>
      </div>
      {advanced || !plan ? (
        <>
          <textarea
            className="plan-editor"
            aria-label="Wiki 计划 JSON"
            spellCheck={false}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {!plan && (
            <p className="field-hint">
              当前 JSON 无法作为表单读取，请修正后切换。保存时还会验证路径、重复
              ID 与循环依赖。
            </p>
          )}
        </>
      ) : (
        <div className="plan-form">
          <section className="plan-scope">
            <h3>源码范围</h3>
            <p>
              一行一个路径通配符。密钥文件、依赖与运行目录仍由安全扫描器排除。
            </p>
            <div>
              <label>
                包含路径
                <PatternInput
                  label="包含路径"
                  value={plan.include || []}
                  placeholder="src/**"
                  onChange={(include) => update({ ...plan!, include })}
                />
              </label>
              <label>
                排除路径
                <PatternInput
                  label="排除路径"
                  value={plan.exclude || []}
                  placeholder="**/test/**"
                  onChange={(exclude) => update({ ...plan!, exclude })}
                />
              </label>
            </div>
          </section>
          <section className="plan-pages">
            <header>
              <div>
                <h3>
                  页面计划 <span>{plan.pages?.length || 0}</span>
                </h3>
                <p>
                  指定页面主题、写作目标和源码范围。页面 ID 中的 /
                  形成导航分组。
                </p>
              </div>
              <button
                type="button"
                className="button small"
                onClick={() => {
                  let n = (plan!.pages?.length || 0) + 1;
                  while (plan!.pages?.some((p) => p.id === `page-${n}`)) n++;
                  update({
                    ...plan!,
                    pages: [
                      ...(plan!.pages || []),
                      {
                        id: `page-${n}`,
                        title: "新页面",
                        goal: "",
                        patterns: ["**"],
                        depends_on: [],
                      },
                    ],
                  });
                }}
              >
                添加页面
              </button>
            </header>
            {(plan.pages || []).map((page, index) => (
              <fieldset className="plan-page" key={index}>
                <legend>页面 {index + 1}</legend>
                <div className="plan-page-head">
                  <label>
                    页面 ID
                    <input
                      aria-label={`页面 ${index + 1} ID`}
                      value={page.id || ""}
                      onChange={(e) => editPage(index, "id", e.target.value)}
                    />
                  </label>
                  <label>
                    标题
                    <input
                      aria-label={`页面 ${index + 1} 标题`}
                      value={page.title || ""}
                      onChange={(e) => editPage(index, "title", e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="plan-remove"
                    aria-label={`移除页面 ${index + 1}`}
                    onClick={() =>
                      update({
                        ...plan!,
                        pages: plan!.pages!.filter((_, i) => i !== index),
                      })
                    }
                  >
                    移除
                  </button>
                </div>
                <label>
                  写作目标
                  <textarea
                    aria-label={`页面 ${index + 1} 写作目标`}
                    value={page.goal || ""}
                    onChange={(e) => editPage(index, "goal", e.target.value)}
                  />
                </label>
                <div className="plan-page-details">
                  <label>
                    源码范围
                    <PatternInput
                      label={`页面 ${index + 1} 源码范围`}
                      value={Array.isArray(page.patterns) ? page.patterns : []}
                      onChange={(patterns) =>
                        editPage(index, "patterns", patterns)
                      }
                    />
                  </label>
                  <label>
                    依赖页面 ID
                    <PatternInput
                      label={`页面 ${index + 1} 依赖页面`}
                      value={
                        Array.isArray(page.depends_on) ? page.depends_on : []
                      }
                      onChange={(depends) =>
                        editPage(index, "depends_on", depends)
                      }
                    />
                  </label>
                </div>
              </fieldset>
            ))}
            {!plan.pages?.length && (
              <p className="field-hint">
                请至少添加一个页面。保存后按指定列表生成，移除的旧页面将由引擎安全归档。
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
