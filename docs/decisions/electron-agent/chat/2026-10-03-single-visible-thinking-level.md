---
title: 模型只露出一个思考档时，默认锁在这一档并显示出来
status: active
date: 2026-10-03
scope: electron-agent/chat
files:
  - electron-agent/src/features/chat/input/thinkingLevels.ts
  - electron-agent/src/features/chat/input/actions/ModelThinkingAction.tsx
supersedes:
superseded_by:
---

## 背景

供应商设置里可以按档关掉「出现」。只留一档时，对话栏用「可见档多于一个才算推理模型」把档位整段藏掉；会话若还停在已隐藏的档，分段控件的值对不上选项，看起来也是空的。

## 决定

只露出一个思考档时，这一档就是默认档。输入栏和面板都显示它。当前档不在可见档里时，改写到模型默认档（这一档），并同步到会话。

## 放弃的方案

- 继续用档位数量判断是否显示：一档和「没有推理」分不开，用户会看到模型名旁边什么都没有。
- 只在本地把显示改成这一档、不写回会话：界面是高，发出去仍是原来的档。

## 后果

收窄可见档会改掉会话上已经选中、但现在不可见的档。多档模型的默认仍是「中」，没有「中」才退到最低的可见推理档。
