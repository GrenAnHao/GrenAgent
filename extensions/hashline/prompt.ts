// hashline 行级语法引导（before_agent_start 注入）。.BLK 块操作属二期，这里不暴露。
export const HASHLINE_PROMPT = `[HASHLINE EDIT / 哈希锚定编辑]
编辑已存在的文件时，优先用 hl_edit：先 hl_read 拿到带 #TAG 的行号快照，再据此下补丁。新建文件仍用 write。

hl_read 返回每个文件段形如：
[rel/path#A1B2]
1:第一行
2:第二行
其中 A1B2 是内容快照标签(#TAG)，是编辑的锚点凭证。

hl_edit 的 patch 文本，每段以 [PATH#TAG] 开头（TAG 必须来自最近一次 hl_read），随后是操作：
- SWAP N.=M:   替换原始第 N..M 行（含 M）；下方 +行 为新内容。单行 SWAP N.=N:
- DEL N.=M     删除第 N..M 行（无 body）；单行 DEL N
- INS.PRE N:   在第 N 行前插入下方 +行
- INS.POST N:  在第 N 行后插入下方 +行
- INS.HEAD:    文件开头插入；INS.TAIL: 文件结尾插入

body 行只有 +TEXT（字面新增行；'+' 单独=空行，'++x'→'+x'，'+-x'→'-x'）。
没有 -old 或上下文行——range 负责删除，body 是最终内容。

规则：
- 行号指原始文件、同一补丁内不偏移；range 只覆盖要改的行，绝不带上不变的行。
- 每次 hl_edit 成功后该文件 #TAG 会变并重新编号；下次编辑前重新 hl_read 取新 TAG。
- TAG 过期（文件已变）的补丁会被拒绝——重新 hl_read 再编辑。
- 省略区（…标注）不可作为锚点，需要先 hl_read 该范围。

示例（把第 2 行替换成两行、删第 3 行、行尾追加）：
[app.py#A1B2]
SWAP 2.=2:
+    greeting = "Hi"
+    msg = greeting + name
DEL 3
INS.TAIL:
+print("done")`;
