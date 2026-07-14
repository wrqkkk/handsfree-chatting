# handsfree-chatting V2 项目进度快照

保存日期：2026-07-14

## 当前版本定位

当前版本升级为 **V2 / 0.2.0 Reliability & Recovery**。

项目仍然坚持低 agency、human-in-the-loop 的定位：用户决定目标、思考方向、prompt 内容与判断，插件只自动化等待、轮次推进、状态监测和普通异常恢复。项目不追求复杂 Agent，而是优先减少低认知价值、高注意力干扰的 interaction overhead。

当前核心原则是：**可靠性优先于智能性；刷新不是完成证据；只有 confirmed completed 才能推进；无法确认时暂停，绝不盲目继续。**

## V2 解决的真实问题

V1 已经实现 prompt queue 的最小闭环，但真实使用中出现了关键故障模式：ChatGPT 前端卡住，插件持续等待；用户手动刷新后，完整回答已经出现，但旧 content script 已被销毁，插件无法识别当前回答已经完成，也无法正确恢复。

V2 针对这一故障加入完整恢复协议：连续五分钟没有有效进展时，自动刷新绑定的 ChatGPT 标签页；刷新后重新加载 content script；重新定位当前 user prompt；查找该 prompt 后对应的 assistant turn；重新评估回答是否完成；只有确认完成才推进下一条。

## V2 新增的任务身份信息

每个 in-flight prompt 现在会持久保存：prompt 文本、prompt hash、发送前 user message 数量、发送前 assistant message 数量、发送时间、最后一次有效进展时间、最后一次进展签名、恢复次数、当前 phase、绑定的 tab ID 与 conversation URL。

这些信息用于刷新后的状态重建和重复发送保护。

## 新的 prompt-response 对应验证

V2 不再只依赖 currentIndex。恢复时会在当前 conversation 的 DOM 中查找与当前 prompt 精确对应的 user turn，优先利用发送前 user message 数量确定预期位置，并用 normalized text 与 hash 进行验证。

找到 user turn 后，继续检查它后面、下一个 user turn 之前是否存在 assistant turn。这样可以建立当前 prompt 与回答之间的页面证据链。

## 新的完成判定机制

V2 同时观察以下信号：当前 prompt 是否存在；对应 assistant turn 是否存在；assistant 是否包含可渲染内容；停止生成按钮是否存在；继续生成按钮是否存在；assistant turn 内是否存在 active tool signal；页面是否存在已知错误；回答是否连续稳定十秒。

内部判定不再只有 true/false，而是区分：confirmed completed、confirmed not completed、uncertain，以及 error。

只有 confirmed completed 可以推进 currentIndex。

## 五分钟无进展检测

V2 明确区分 total elapsed time 与 no-progress time。

只要 assistant 文本、assistant turn、停止状态、继续生成状态、工具运行状态或错误状态发生有效变化，lastProgressAt 就会更新。

连续五分钟无任何有效进展时，系统判定为 stall suspected，并触发恢复。

## 自动刷新与恢复

自动恢复的流程是：保存 recovering 状态与恢复次数；通过 background service worker 刷新当前绑定标签页；新 content script 加载后读取 chrome.storage.local；确认 running=true 且 inFlightIndex 非空；确认当前 tab ID 与 queueTabId 一致；进入 recovery_verifying；重新建立 prompt-response 证据链。

刷新本身绝不被视为回答完成。

## 恢复次数限制

每条 prompt 最多进行两次自动刷新恢复。

第一次连续五分钟无进展后执行第一次自动恢复；恢复后若再次连续五分钟无进展，执行第二次自动恢复；第二次恢复后仍然无法确认完成，则暂停队列并报告错误，不进入无限刷新循环。

## 重复发送保护

V2 在真正点击发送按钮之前，先写入 sending_prepared / send_attempted 状态和 prompt 身份信息。

如果浏览器在发送临界区发生异常，恢复逻辑不会直接重新发送，而是先扫描 conversation。只要存在任何无法确认的情况，就暂停，从而优先防止 duplicate send 和后续上下文污染。

## 标签页绑定

V2 新增 background.js。background service worker 负责向 content script 返回当前 tab ID，并在恢复时刷新发送消息的 ChatGPT tab。

队列开始时会保存 queueTabId。页面刷新后，只允许同一 tab 自动恢复。这减少了多个 ChatGPT 标签页共享全局 chrome.storage.local 时误接管队列的风险。

当前仍只支持一个 active queue。真正的多标签页独立 queue 仍留给后续版本。

## 当前状态机

当前内部 phase 已扩展为：idle、running、sending_prepared、send_attempted、waiting_for_start、generating、refreshing、recovery_verifying、completed、paused、error。

用户界面保持简洁，仅展示运行中、等待回答、正在恢复、正在验证、已暂停、已完成或出现错误。

## 当前实验参数

轮询间隔为 1 秒；回答稳定窗口为 10 秒；无进展阈值为 5 分钟；刷新后恢复验证窗口为 60 秒；每条 prompt 最多自动刷新 2 次；单条回答总等待上限为 30 分钟。

## V2 验收场景

关键成功场景是：prompt 已发送；ChatGPT 正在回答；前端卡住超过五分钟；插件自动刷新；刷新后定位同一 prompt；发现对应完整 assistant response；确认无 stop、continue generating 或 active tool 状态；回答稳定十秒；当前 prompt 标记完成；自动发送下一条。

关键安全场景是：刷新后找不到当前 prompt，或者无法确认对应 assistant response 已完整结束。此时插件不得发送下一条，也不得自动重发当前 prompt，而应继续观察或暂停。

## 当前仍未解决的问题

当前调度器主体仍位于 content.js，而 background.js 只负责标签页身份与刷新。因此它还不是完整的 background-owned scheduler。

当前 chrome.storage.local 仍保存单一全局队列状态，因此不支持多个 ChatGPT 标签页同时运行多个独立队列。

ChatGPT DOM selector 变化仍可能导致检测失效。后续可增加 DOM health check 和更明确的错误分类。

## 下一阶段建议

在 V2 真实跑一段时间并收集故障模式后，下一步最值得加入的是 Windows / Edge 完成与失败通知、运行日志、逐条 prompt 状态，以及 DOM health check。

再之后才适合进行真正的多队列架构重构：background service worker 作为权威调度器，content.js 作为页面执行器，popup 作为控制面板，并以 queueId + tabId + conversationUrl 管理多个独立任务。
