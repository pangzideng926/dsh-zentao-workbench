/**
 * 禅道工作台 · 浏览器（Client）半侧。
 *
 * 契约（来自 DSH 客户端模块系统）：
 *   - 本文件是「已构建的浏览器 bundle」入口，必须是一个普通副作用脚本：加载时调用
 *     `window.__ModuleLoader__.load({ id, factory })`，不允许出现顶层 ESM import/export。
 *   - `id` 必须等于包名（`dsh-zentao-workbench`），否则不会挂到对应的图行上。
 *   - factory 在首次物化时执行，通过注入的 `require` 取基线外部模块（react 由模块表提供），
 *     返回 `{ name, inject, apply }` 交给 Cordis 激活。
 *   - inject 里的 `slots` / `sessions` / `workspaces` 是客户端 Cordis 服务名，不是 npm 包名。
 *     宿主半侧自己用 `ctx.inject(['webServer'], …)` 注册 `POST /zentao-workbench/<endpoint>`，
 *     浏览器侧用同源 fetch（带 Cookie）对接 —— 不用 `ctx.connection.rpc`，原因见 callRpc 注释。
 */

window.__ModuleLoader__.load({
  id: 'dsh-zentao-workbench',

  factory: (require) => {
    const module = { exports: {} };

    const react = require('react');
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = react;

    /** Cordis 插件名。 */
    const name = 'zentao-workbench';

    /** 需要的客户端服务：挂载点、RPC 通道、以及「新建对话并发送」所需的会话/项目服务。 */
    const inject = ['slots', 'sessions', 'workspaces'];

    /** 与宿主半侧约定的 RPC 方法名。 */
    const RPC_METHOD = '/zentao-workbench';

    /** 挂载点标识（同一 slot 内唯一）。 */
    const SLOT_ID = 'zentao-workbench';

    /**
     * 提示词抬头（用户 m04648「提示词似乎不对劲 如何优化？」）。
     *
     * 界面上的职位选择在用户 m01631 时已取消，只留「开发」一套写死预设；结果是：
     * 不管条目是 Bug、优化还是需求，都套同一段开发视角的话术，正文还没带上。
     * 现在改成「先判类别、再按类别走套路」，并加硬要求（先看代码再下结论、结论先行）。
     */
    const PROMPT_INTRO = [
      '你是我的研发助手，负责把下面这条禅道条目推进到可交付状态。',
      '',
      '## 第一步：先判类别',
      '读完条目后先用一行给出判断：**Bug 修复 / 体验或性能优化 / 新增需求 / 其它**，并附一句依据。',
      '证据不足时直接说缺什么、先问我，不要硬猜。',
      '',
      '## 第二步：按类别走对应的套路',
      '- Bug 修复：复现路径 → 根因 → 修复方案与改动点 → 回归范围与自测',
      '- 体验或性能优化：现状与基线 → 瓶颈定位（先量后改）→ 优化方案与预期收益 → 回归验证',
      '- 新增需求：目标与验收标准 → 方案与拆分 → 影响面与风险 → 实施顺序',
      '- 其它：先澄清目标，再给最小可行的下一步',
      '',
      '## 硬要求',
      '- 涉及代码时，先在工作区里找到相关文件再下结论，不要凭猜测给方案。',
      '- 结论先行，再给证据；不要复述我贴给你的原文。',
      '- 需要我拍板的点集中放在最后，一次问清楚；能让工作台自动做的（改状态、填耗时、指派）提醒我用按钮操作。',
    ].join('\n');

    /** 四个类别的中文名（与宿主 analyze 端点的口径一致）。 */
    const CATEGORY_LABEL = { bug: 'Bug 修复', optimize: '体验或性能优化', feature: '新增需求', other: '其它' };

    /** 关键词线索（确定性判断，只作为提示词里的线索，不锁死模型结论）。 */
    const BUG_WORDS = /(报错|异常|崩溃|闪退|失败|不生效|无法|打不开|乱码|错乱|不对|复现|超时失败|500|404|报毒)/;
    const OPT_WORDS = /(慢|卡顿|卡死|很卡|性能|加载|转圈|体验|繁琐|重复操作|优化|太大了|不友好|难用|白屏)/;
    const FEATURE_WORDS = /(新增|增加|支持|希望|建议|能否|需要|需求|改造|对接|扩展)/;

    /**
     * 按类别猜测 + 命中线索；给提示词里的「线索」段用。
     * @param {string} kind - task / bug / story。
     * @param {object} item - 列表行。
     */
    function categoryClues(kind, item) {
      const title = String(item?.title ?? '');
      const hits = [];
      if (BUG_WORDS.test(title)) hits.push('标题里出现报错/失败类词 → 更像 Bug');
      if (OPT_WORDS.test(title)) hits.push('标题里出现慢/卡/体验类词 → 更像优化');
      if (FEATURE_WORDS.test(title)) hits.push('标题里出现新增/支持/需求类词 → 更像需求');
      if (item?.severity !== undefined && String(item.severity) !== '') hits.push(`严重程度：${String(item.severity)}`);
      if (item?.priority !== undefined && String(item.priority) !== '') hits.push(`优先级：${String(item.priority)}`);
      if (item?.statusLabel !== undefined && item.statusLabel !== '') hits.push(`当前状态：${String(item.statusLabel)}`);
      const guess = kind === 'bug' ? 'bug' : kind === 'story' ? 'feature' : BUG_WORDS.test(title) ? 'bug' : OPT_WORDS.test(title) ? 'optimize' : FEATURE_WORDS.test(title) ? 'feature' : 'other';
      return { guess, hits };
    }

    /** 把宿主 analyze 端点返回的预判结果拼成提示词/界面用的纯文本。 */
    function formatAnalysisText(analysis) {
      if (analysis === undefined || analysis === null) return '';
      const lines = [
        '## AI 预判（工作台按当前模型给出，仅供参考，请自行复核）',
        `- 类别：${analysis.categoryLabel || CATEGORY_LABEL[analysis.category] || analysis.category}${analysis.confidence === null || analysis.confidence === undefined ? '' : `（置信度 ${analysis.confidence}）`}`,
      ];
      if (analysis.headline) lines.push(`- 一句话：${analysis.headline}`);
      if (analysis.reason) lines.push(`- 依据：${analysis.reason}`);
      if (Array.isArray(analysis.steps) && analysis.steps.length > 0) {
        lines.push('- 建议步骤：');
        analysis.steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
      }
      if (Array.isArray(analysis.questions) && analysis.questions.length > 0) lines.push(`- 待确认：${analysis.questions.join('；')}`);
      if (analysis.provider || analysis.model) {
        const source =
          analysis.routeSource === 'dsh' ? 'DSH 默认模型' : analysis.routeSource === 'env' ? '环境变量指定' : '自动挑选';
        lines.push(`- 由 ${analysis.provider || ''}/${analysis.model || ''}（${source}）在 ${analysis.analyzedAt || ''} 给出`);
      }
      if (analysis.routeNote) lines.push(`- 说明：${analysis.routeNote}`);
      if (analysis.truncated) lines.push(`- 说明：模型输出触到 maxTokens 上限，上面这条结论可能被截断，请以正文为准。`);
      return lines.join('\n');
    }

    const KIND_LABEL = { task: '任务', bug: 'Bug', story: '需求' };
    /** tab/条目 kind（单数）→ refresh 快照里的字段名（复数）。 */
    const KIND_LIST = { task: 'tasks', bug: 'bugs', story: 'stories' };
    const IMAGE_FILE_PATTERN = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;
    /** 视频附件（禅道里确实有 mp4 录屏）在卡片里直接出播放器。 */
    const VIDEO_FILE_PATTERN = /\.(mp4|m4v|webm|ogv|ogg|mov|avi|mkv|3gp)$/i;
    /** PDF 走工作台内的 iframe 预览（宿主代理已回 `application/pdf` + `content-disposition: inline`）。 */
    const PDF_FILE_PATTERN = /\.pdf$/i;
    /** Office / WPS 文档：点一下让**电脑上的默认程序**（Word / Excel / WPS）打开。 */
    const OFFICE_FILE_PATTERN = /\.(docx?|docm|dotx?|rtf|odt|wps|wpt|xlsx?|xlsm|xlsb|ods|et|pptx?|ppsx?|odp|dps|csv)$/i;
    /** 图片附件在卡片里直接出缩略图（地址走宿主代理，否则禅道直链只会返回登录页）。 */
    const isImageAttachment = (file) =>
      IMAGE_FILE_PATTERN.test(String(file.url ?? '')) || IMAGE_FILE_PATTERN.test(String(file.name ?? ''));
    const isVideoAttachment = (file) =>
      VIDEO_FILE_PATTERN.test(String(file.url ?? '')) || VIDEO_FILE_PATTERN.test(String(file.name ?? ''));
    const isPdfAttachment = (file) =>
      PDF_FILE_PATTERN.test(String(file.url ?? '')) || PDF_FILE_PATTERN.test(String(file.name ?? ''));
    const isOfficeAttachment = (file) =>
      OFFICE_FILE_PATTERN.test(String(file.url ?? '')) || OFFICE_FILE_PATTERN.test(String(file.name ?? ''));

    /**
     * 浮层样式：只注入一次，随插件卸载一起移除。
     *
     * 配色全部走 DSH 的 `--dsw-*` 设计令牌（定义在 @deepseek-ai/dsh-client-ui-theme 的
     * `body{…}` / `body[data-ds-dark-theme]{…}` 上，随主题明暗自适应），每个令牌都带一个
     * 暗色实测值的 fallback，令牌缺失时也不会掉成透明。刻意不 import 主题包 —— 官方
     * @deepseek-ai/dsh-client-ui-primitives 的 README 明确「组件只通过 --dsw-* 令牌上色」。
     */
    const CSS = `
.dzw-root {
  position: fixed; inset: 0; pointer-events: none; z-index: 900;
  /* 工作台面板与详情卡片共用同一高度：面板固定高（列表内滚动，切分类不缩水），
     详情卡片跟着一样高，两者底边对齐。 */
  --dzw-frame-height: min(76vh, 720px);
}
.dzw-root * { box-sizing: border-box; }
.dzw-launcher {
  position: absolute; right: 18px; bottom: 18px; pointer-events: auto;
  width: 48px; height: 48px; border-radius: 50%;
  border: 1px solid var(--dsw-alias-border-l3, #ffffff29);
  background: var(--dsw-alias-button-primary-fill, #f9fafb);
  color: var(--dsw-alias-label-primary-foreground, #0f1115);
  font-family: var(--dsw-font-family, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
  font-size: 18px; font-weight: 600;
  cursor: pointer; box-shadow: var(--dsw-shadow-lv3, 0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px 0 #00000014);
  display: flex; align-items: center; justify-content: center;
}
.dzw-launcher:hover { background: var(--dsw-alias-button-primary-hover, #ebeef2); }
.dzw-launcher .dzw-dot {
  position: absolute; right: 2px; bottom: 2px; width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid var(--dsw-alias-bg-layer-2, #2c2c2e);
}
.dzw-dot.on { background: var(--dsw-alias-state-success-primary, #22c55e); }
.dzw-dot.off { background: var(--dsw-alias-label-dimmed, #43454a); }
.dzw-panel {
  position: absolute; right: 18px; bottom: 78px; pointer-events: auto;
  width: 400px; max-width: calc(100vw - 36px); height: var(--dzw-frame-height); max-height: calc(100vh - 100px);
  display: flex; flex-direction: column; overflow: hidden;
  border-radius: var(--dsw-radius-lg, 16px);
  border: 1px solid var(--dsw-alias-border-l3, #ffffff29);
  background: var(--dsw-specific-menu, var(--dsw-menu-surface-fill, #303136f0));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
  color: var(--dsw-alias-label-primary, #f9fafb);
  box-shadow: var(--dsw-shadow-lv3, 0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px 0 #00000014);
  font-family: var(--dsw-font-family, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
  font-size: 13px; line-height: 20px;
}
.dzw-head {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
}
.dzw-title { font-weight: 600; font-size: 13px; }
.dzw-sub { color: var(--dsw-alias-label-secondary, #61666b); font-size: 11px; margin-left: auto; }
.dzw-icon {
  pointer-events: auto; cursor: pointer; padding: 2px 8px; font-size: 12px; line-height: 18px;
  border-radius: var(--dsw-radius-xs, 4px);
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: transparent; color: var(--dsw-alias-label-secondary, #61666b);
  font-family: inherit;
}
.dzw-icon:hover { background: var(--dsw-alias-interactive-bg-hover, #ffffff14); }
.dzw-icon:disabled { opacity: .45; cursor: not-allowed; }
.dzw-body { padding: 10px 12px; overflow: auto; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dzw-body::-webkit-scrollbar { width: 8px; height: 8px; }
.dzw-body::-webkit-scrollbar-thumb,
.dzw-list::-webkit-scrollbar-thumb {
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-scrollbar-bg-l2, #545557);
}
.dzw-list::-webkit-scrollbar { width: 8px; }
.dzw-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.dzw-row > label { width: 60px; color: var(--dsw-alias-label-secondary, #61666b); flex: none; font-size: 12px; }
.dzw-input, .dzw-select {
  flex: 1; min-width: 0; padding: 5px 8px; font-size: 12px; outline: none;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-3, #353638));
  color: var(--dsw-alias-label-primary, #f9fafb); font-family: inherit;
}
.dzw-input::placeholder { color: var(--dsw-alias-label-dimmed, #43454a); }
.dzw-input:focus, .dzw-select:focus { border-color: var(--dsw-alias-state-business-primary, #5686fe); }
.dzw-check { display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary, #61666b); font-size: 12px; }
.dzw-btn {
  pointer-events: auto; cursor: pointer; padding: 5px 10px; font-size: 12px; font-family: inherit;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: var(--dsw-alias-bg-layer-3, #353638);
  color: var(--dsw-alias-label-secondary, #61666b);
}
.dzw-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #ffffff14); }
.dzw-btn:disabled { opacity: .5; cursor: not-allowed; }
.dzw-btn.primary {
  background: var(--dsw-alias-button-primary-fill, #f9fafb);
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, #0f1115);
}
.dzw-btn.primary:hover { background: var(--dsw-alias-button-primary-hover, #ebeef2); }
.dzw-btn.ghost { background: transparent; }
.dzw-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }
.dzw-tab {
  pointer-events: auto; cursor: pointer; flex: 1 0 auto; white-space: nowrap; text-align: center; padding: 5px 8px; font-size: 12px; font-family: inherit;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: transparent; color: var(--dsw-alias-label-tertiary, #81858c);
}
.dzw-tab:hover { background: var(--dsw-alias-interactive-bg-hover, #ffffff14); }
.dzw-tab.active {
  background: var(--dsw-alias-interactive-bg-active, #ffffff24);
  border-color: var(--dsw-alias-border-l4, #ffffff3d);
  color: var(--dsw-alias-label-primary, #f9fafb);
}
.dzw-target {
  display: flex; align-items: center; gap: 8px;
  margin: 0 0 8px; padding: 6px 8px; font-size: 11px;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 1px solid var(--dsw-alias-border-l1, #ffffff0f);
  background: var(--dsw-alias-interactive-bg-hover, #ffffff14);
  color: var(--dsw-alias-label-secondary, #61666b);
}
.dzw-target-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 发送目标选择器：工作区可能有多个（用户 m03741），下拉里选一个就发到那里。 */
.dzw-target .dzw-select { flex: 0 1 auto; max-width: 52%; cursor: pointer; font-size: 11px; padding: 3px 6px; }
.dzw-list { display: flex; flex-direction: column; gap: 6px; flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-right: 2px; }
.dzw-item {
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  border-radius: var(--dsw-radius-sm, 8px); padding: 8px;
  background: var(--dsw-alias-bg-layer-2, #2c2c2e);
}
.dzw-item-head { display: flex; gap: 6px; align-items: baseline; }
.dzw-item-title { flex: 1; min-width: 0; font-size: 12.5px; color: var(--dsw-alias-label-primary, #f9fafb); word-break: break-word; cursor: pointer; }
.dzw-item-title:hover { color: var(--dsw-alias-link, #7aaaff); }
.dzw-meta { color: var(--dsw-alias-label-secondary, #61666b); font-size: 11px; margin-top: 4px; display: flex; flex-wrap: wrap; gap: 8px; }
.dzw-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.dzw-link { color: var(--dsw-alias-link, #7aaaff); text-decoration: none; font-size: 11px; }
.dzw-link:hover { text-decoration: underline; }
/* AI 预判块（用户 m04648 选的 C 方案）：类别标签 + 依据 + 建议步骤，跟在条目下方。 */
.dzw-analysis {
  margin-top: 6px; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px;
  border: 1px dashed var(--dsw-alias-border-l2, #ffffff1f);
  border-radius: var(--dsw-radius-xs, 6px);
  background: var(--dsw-alias-bg-layer-3, #3a3a3c);
  font-size: 11px; color: var(--dsw-alias-label-secondary, #61666b);
}
.dzw-analysis-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dzw-analysis-tag { color: var(--dsw-alias-label-primary, #f9fafb); font-size: 11.5px; font-weight: 600; }
.dzw-analysis-model { margin-left: auto; opacity: 0.7; }
.dzw-analysis-line { color: var(--dsw-alias-label-primary, #f9fafb); line-height: 1.5; }
.dzw-analysis-why { line-height: 1.5; }
.dzw-analysis-steps { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 2px; line-height: 1.5; }
.dzw-analysis-note { line-height: 1.5; color: var(--dsw-alias-label-secondary, #61666b); }
        /* 详情用悬浮卡片，浮在面板左边，不铺全屏遮罩：不压暗、不挡其它点击。 */
        .dzw-modal {
          pointer-events: auto; position: fixed; z-index: 60;
          right: 430px; bottom: 78px;
          display: flex; flex-direction: column;
          width: min(520px, calc(100vw - 460px));
          height: var(--dzw-frame-height); max-height: calc(100vh - 100px);
          border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
          border-radius: var(--dsw-radius-lg, 16px);
          background: var(--dsw-specific-menu, var(--dsw-menu-surface-fill, #303136f0));
          backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
          box-shadow: var(--dsw-shadow-lv3, 0 12px 32px #00000040);
          color: var(--dsw-alias-label-primary, #f9fafb);
        }
        /* 窄屏：面板占满宽度，详情改为浮在面板上方（高度自适应，避免顶出屏幕） */
        @media (max-width: 900px) {
          .dzw-modal { right: 18px; bottom: auto; top: 72px; width: min(400px, calc(100vw - 36px)); height: auto; max-height: min(60vh, 520px); }
        }
.dzw-modal-head {
  display: flex; align-items: baseline; gap: 8px;
  padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
}
.dzw-modal-title { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; word-break: break-word; }
.dzw-modal-close {
  pointer-events: auto; cursor: pointer; flex: none; font: inherit; font-size: 12px; padding: 3px 8px;
  border-radius: var(--dsw-radius-xs, 4px);
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: transparent; color: var(--dsw-alias-label-tertiary, #81858c);
}
.dzw-modal-close:hover { background: var(--dsw-alias-interactive-bg-hover, #ffffff14); color: var(--dsw-alias-label-primary, #f9fafb); }
.dzw-modal-body { overflow: auto; padding: 12px 14px; flex: 1; min-height: 0; }
.dzw-section { margin: 0 0 10px; }
.dzw-section-label { font-size: 11px; color: var(--dsw-alias-label-secondary, #61666b); margin-bottom: 3px; }
.dzw-section pre { white-space: pre-wrap; word-break: break-word; margin: 0; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary, #0f1115); }
.dzw-attach { display: flex; flex-direction: column; gap: 4px; }
.dzw-attach a { font-size: 12px; word-break: break-all; }
.dzw-attach-item { display: flex; flex-direction: column; gap: 4px; }
.dzw-attach-head { display: flex; align-items: center; gap: 8px; }
.dzw-thumb-link { display: inline-block; align-self: flex-start; padding: 0; border: none; background: none; cursor: zoom-in; }
.dzw-zoom { padding: 0; border: none; background: none; cursor: zoom-in; font: inherit; }
.dzw-zoom:hover { text-decoration: underline; }
.dzw-thumb { display: block; max-width: 100%; max-height: 190px; margin-top: 2px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #0000001f); }
.dzw-video { display: block; max-width: 100%; max-height: 190px; margin-top: 2px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, #0000001f); background: #000; }
/* 图片放大预览：**不铺灰色遮罩**（和详情卡片一样的「悬浮」口径）。
   外层只负责铺满视口接住「点空白处关闭」，本身全透明；真正显示图片的是一张带边框与阴影的悬浮卡片，
   卡片里上方一排（文件名 / 新窗口打开 / 关闭），下方再给一个关闭按钮和「点空白处或按 Esc 也能关闭」的提示。 */
.dzw-preview {
  pointer-events: auto; position: fixed; inset: 0; z-index: 70;
  display: flex; align-items: center; justify-content: center; padding: 24px;
  background: transparent;
}
.dzw-preview-card {
  display: flex; flex-direction: column; gap: 8px;
  max-width: min(92vw, 1600px); max-height: calc(100vh - 48px);
  padding: 10px; border: 1px solid var(--dsw-alias-border-l2, #0000001f);
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-alias-bg-layer-2, #2c2c2e);
  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px #00000040);
}
.dzw-preview-head { display: flex; align-items: center; gap: 8px; }
.dzw-preview-img {
  display: block; max-width: 100%; max-height: calc(100vh - 150px); object-fit: contain;
  border-radius: var(--dsw-radius-sm, 8px);
}
.dzw-preview-video {
  display: block; max-width: 100%; max-height: calc(100vh - 150px);
  border-radius: var(--dsw-radius-sm, 8px); background: #000;
}
/* PDF：直接用浏览器内置阅读器渲染（宿主代理已回 application/pdf + inline），所以给一个高一点的框。 */
.dzw-preview-pdf {
  display: block; width: min(92vw, 1100px); height: calc(100vh - 190px); min-height: 320px;
  border: 1px solid var(--dsw-alias-border-l2, #0000001f);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-2, #2c2c2e);
}
.dzw-preview-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #61666b); font-size: 12px; }
.dzw-preview-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dzw-preview-hint { color: var(--dsw-alias-label-secondary, #61666b); font-size: 12px; }
.dzw-preview-close {
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  pointer-events: auto; cursor: pointer; font: inherit; font-size: 12px; font-weight: 500;
  padding: 6px 12px;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 1px solid var(--dsw-alias-border-l3, #ffffff3d);
  background: var(--dsw-alias-bg-layer-3, #3a3a3c);
  color: var(--dsw-alias-label-primary, #f9fafb);
  box-shadow: var(--dsw-shadow-lv3, 0 4px 14px #00000059);
}
.dzw-preview-close:hover { background: var(--dsw-alias-interactive-bg-hover, #ffffff26); }
.dzw-preview-x { font-size: 13px; line-height: 1; }
/* 右上角那颗固定在视口上，图片/视频再大也不会把它挤走；深色半透明底压在图上，浅色主题也看得清。 */
.dzw-preview-close-float {
  position: fixed; top: 16px; right: 16px; z-index: 71;
  padding: 7px 14px; font-size: 13px; color: #ffffff;
  background: var(--dsw-alias-bg-mask-3, #0000007a);
  border-color: var(--dsw-alias-border-l3, #ffffff3d);
  backdrop-filter: blur(6px);
}
.dzw-preview-close-float:hover { background: #000000a6; }
.dzw-preview-close-solid { background: var(--dsw-alias-button-primary-fill, #3b6ef5); color: var(--dsw-alias-label-primary-foreground, #ffffff); }
.dzw-preview-close-solid:hover { background: var(--dsw-alias-button-primary-hover, #2f6fe4); }
.dzw-modal-foot {
  display: flex; align-items: center; gap: 8px; padding: 10px 14px; font-size: 11px;
  border-top: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  color: var(--dsw-alias-label-secondary, #61666b);
}
.dzw-hist { margin: 6px 0 0; padding-left: 16px; color: var(--dsw-alias-label-secondary, #61666b); }
.dzw-foot {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px; font-size: 11px;
  border-top: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  color: var(--dsw-alias-label-secondary, #61666b);
}
.dzw-fresh {
  flex: 0 0 auto; font-variant-numeric: tabular-nums;
}
.dzw-progress {
  margin: 4px 12px 0; padding: 4px 8px; font-size: 11px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-interactive-bg-hover, #ffffff0f);
  color: var(--dsw-alias-label-secondary, #61666b);
}
.dzw-msg {
  padding: 6px 8px; margin-bottom: 8px; font-size: 12px;
  border-radius: var(--dsw-radius-sm, 8px);
}
.dzw-msg.err {
  background: var(--dsw-alias-interactive-bg-hover-danger, #f25a5a26);
  color: var(--dsw-alias-state-error-primary, #f25a5a);
  border: 1px solid var(--dsw-alias-state-error-primary, #f25a5a);
}
.dzw-msg.info {
  background: var(--dsw-alias-interactive-bg-hover, #ffffff14);
  color: var(--dsw-alias-label-secondary, #61666b);
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
}
.dzw-empty { color: var(--dsw-alias-label-secondary, #61666b); font-size: 12px; padding: 10px 2px; }
/* 完成 / 指派卡片里的表单与成员列表 */
.dzw-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.dzw-field > label { font-size: 11px; color: var(--dsw-alias-label-secondary, #61666b); }
.dzw-hint { font-size: 11px; color: var(--dsw-alias-label-secondary, #61666b); word-break: break-word; }
.dzw-textarea { min-height: 56px; resize: vertical; line-height: 1.5; font: inherit; font-size: 12px; }
.dzw-user-list { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
.dzw-user {
  display: flex; align-items: baseline; gap: 8px; text-align: left; cursor: pointer;
  font: inherit; font-size: 12px; padding: 5px 8px;
  border-radius: var(--dsw-radius-xs, 4px);
  border: 1px solid var(--dsw-alias-border-l2, #ffffff1f);
  background: transparent; color: var(--dsw-alias-label-primary, #f9fafb);
}
.dzw-user:hover { background: var(--dsw-alias-interactive-bg-hover, #ffffff14); }
.dzw-user-name { flex: 1; min-width: 0; word-break: break-word; }
.dzw-user-account { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary, #81858c); }
`;

    /**
     * 调用宿主半侧的自有 HTTP 路由。
     *
     * 传输层说明：宿主半侧**没有**用 `ctx.connection.rpc.handle(...)` —— 它在内部
     * 以 `const owner = this.ctx` 取「当前上下文」再 `owner.webServer.register(...)`，
     * 这个 tracker 会跳过 `ctx.inject` 派生的影子上下文，第三方插件行上必然抛
     * `cannot get property "webServer" without inject`（插件被跳过，界面只会看到 HTTP 405）。
     * 所以宿主半侧直接用 `ctx.inject(['webServer'], …)` 注册 `POST /zentao-workbench/<endpoint>`，
     * 这里就用普通 fetch（同源、带 Cookie）对接。
     *
     * @param {string} endpoint - 端点名。
     * @param {object} payload - 载荷。
     */
    async function callRpc(endpoint, payload) {
      let response;
      try {
        response = await fetch(`${RPC_METHOD}/${encodeURIComponent(endpoint)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload ?? {}),
        });
      } catch (error) {
        throw new Error(`无法连接宿主半侧：${error instanceof Error ? error.message : String(error)}`);
      }
      let result;
      try {
        result = await response.json();
      } catch {
        result = undefined;
      }
      if (result === undefined || result === null || typeof result !== 'object') {
        throw new Error(`宿主半侧无响应（HTTP ${response.status}）`);
      }
      if (result.ok !== true) {
        const message = result.error && typeof result.error.message === 'string' ? result.error.message : `未登录或请求失败（HTTP ${response.status}）`;
        const code = result.error && typeof result.error.code === 'string' ? result.error.code : '';
        const failure = new Error(message);
        // 保留宿主给的错误码：调用方要据此区分「登录失效（可恢复）」和普通错误。
        failure.code = code;
        throw failure;
      }
      return result.value;
    }

    /** 复制文本到剪贴板，返回是否成功。 */
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    }

    /** 可选服务探测：拿不到就返回 undefined，不让缺一个服务把整个浮层拖死。 */
    function peekService(ctx, name) {
      if (ctx === undefined || ctx === null) return undefined;
      try {
        if (typeof ctx.get === 'function') {
          const value = ctx.get(name);
          if (value !== undefined) return value;
        }
      } catch {
        /* 落到属性访问再试一次 */
      }
      try {
        return ctx[name];
      } catch {
        return undefined;
      }
    }

    /**
     * 当前工作区（项目）解析：优先「主面板正在看的会话」所属工作区，其次最近活跃的工作区。
     *
     * 依据本机 DSH 0.2.0-rc.2 源码：`sessions.list` 的行里有 `retainedBy`，
     * 官方取主面板会话的写法就是 `Object.values(list.byId).find((s) => (s.retainedBy.mainView ?? 0) > 0)?.id`；
     * 工作区行形状 `{ workspaceId, path, title, createdAt, sessionIds[] }`。
     *
     * @param {any} sessions - `sessions` 客户端服务。
     * @param {any} workspaces - `workspaces` 客户端服务。
     * @returns {any} 工作区行，找不到返回 undefined。
     */
    function resolveWorkspace(sessions, workspaces) {
      if (sessions === undefined || workspaces === undefined) return undefined;
      const sessionState = sessions.list.getSnapshot();
      const byId = sessionState === null || typeof sessionState !== 'object' || sessionState.byId === undefined ? {} : sessionState.byId;
      const rows = Object.values(byId);
      const workspaceState = workspaces.list.getSnapshot();
      const items = workspaceState !== null && typeof workspaceState === 'object' && Array.isArray(workspaceState.items) ? workspaceState.items : [];
      const mainRow = rows.find((row) => row !== null && typeof row === 'object' && row.retainedBy !== undefined && (row.retainedBy.mainView ?? 0) > 0);
      const mainId = mainRow === undefined ? undefined : mainRow.id;
      if (mainId !== undefined) {
        const owner = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(mainId));
        if (owner !== undefined) return owner;
      }
      let best;
      let bestAt = Number.NEGATIVE_INFINITY;
      for (const item of items) {
        const created = Date.parse(item.createdAt ?? '');
        let at = Number.isNaN(created) ? 0 : created;
        for (const id of Array.isArray(item.sessionIds) ? item.sessionIds : []) {
          const row = byId[id];
          if (row !== undefined && typeof row.updatedAt === 'number' && row.updatedAt > at) at = row.updatedAt;
        }
        if (at > bestAt) {
          bestAt = at;
          best = item;
        }
      }
      return best;
    }

    /** 工作区快照里的全部工作区行（顺序沿用宿主快照，悬浮层下拉里直接展示）。 */
    function listWorkspaces(workspaces) {
      if (workspaces === undefined || workspaces.list === undefined) return [];
      const state = workspaces.list.getSnapshot();
      const items = state !== null && typeof state === 'object' && Array.isArray(state.items) ? state.items : [];
      return items.filter((item) => item !== null && typeof item === 'object' && typeof item.workspaceId === 'string');
    }

    /** 按 ID 找工作区行（用户在下拉里显式选中的那个）。 */
    function findWorkspace(workspaces, workspaceId) {
      if (typeof workspaceId !== 'string' || workspaceId === '') return undefined;
      return listWorkspaces(workspaces).find((item) => item.workspaceId === workspaceId);
    }

    /** 工作区的展示文案：`标题（/path）`。 */
    function describeWorkspace(workspace) {
      if (workspace === undefined || workspace === null) return '';
      const title = workspace.title === undefined || workspace.title === '' ? '未命名项目' : workspace.title;
      return workspace.path === undefined || workspace.path === '' ? title : `${title}（${workspace.path}）`;
    }

    /** 与宿主半侧同口径：按 ID 倒序。 */
    function sortByIdDesc(items) {
      return [...items].sort((left, right) => {
        const a = Number(left.id);
        const b = Number(right.id);
        if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return b - a;
        return String(right.id).localeCompare(String(left.id));
      });
    }

    /**
     * 在工作区里建一个会话并把 `text` 发出去。
     *
     * DSH 0.2.0-rc.2 上真实可用的链路（源码核对，参考实现里的三个 API 在本机并不存在）：
     *   - `workspaces` 服务**没有** `connectWorkspace`，快照里也**没有** `recentWorkspaceId`；
     *   - `sessions` 服务**没有** `open()`，只有 `create / retain / using / scope / fork`；
     *   - 建会话：`uiWorkspace.connectWorkspace(workspaceId)`（复用该目录下的空白会话或新建），
     *     拿不到 `uiWorkspace` 时退化为 `sessions.create({ workspaceId })`；
     *   - 发送：`sessions.retain(id, { source })` 取 reference，`await reference.ready` 拿到
     *     session 作用域上下文，再用 `conversation.send(text)`；
     *   - 展示：`uiWorkspace.openSession(id)` 会把该会话 retain 到 mainView 并选中。
     *
     * @param {any} ctx - 客户端根上下文。
     * @returns {(text: string, targetWorkspaceId?: string) => Promise<{ sessionId: string, workspace: any }>}
     */
    function makeHandlePrompt(ctx) {
      return async (text, targetWorkspaceId) => {
        const sessions = ctx.sessions;
        const workspaces = ctx.workspaces;
        const ui = peekService(ctx, 'uiWorkspace');
        // 用户在下拉里选过工作区就用那个；没选（空串）才跟随主面板当前工作区。
        const picked = findWorkspace(workspaces, targetWorkspaceId);
        if (typeof targetWorkspaceId === 'string' && targetWorkspaceId !== '' && picked === undefined) {
          throw new Error('选中的工作区已不在了（可能已被移除或改名），请重新选一个发送目标');
        }
        const workspace = picked ?? resolveWorkspace(sessions, workspaces);
        if (workspace === undefined) {
          throw new Error('未找到当前项目（工作区），请先在左侧打开一个项目后重试');
        }
        const workspaceId = workspace.workspaceId;
        let sessionId;
        if (ui !== undefined && typeof ui.connectWorkspace === 'function') {
          sessionId = await ui.connectWorkspace(workspaceId);
        } else {
          sessionId = await sessions.create({ workspaceId });
        }
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw new Error('新建会话失败：宿主没有返回会话 ID');
        }
        const reference = sessions.retain(sessionId, { source: 'zentao-workbench' });
        let keepRetained = false;
        try {
          const binding = await reference.ready;
          const conversation = readSessionService(sessions, binding, sessionId, 'conversation');
          if (conversation === undefined) {
            throw new Error('conversation 服务不可用，请确认对话插件已加载');
          }
          if (ui !== undefined && typeof ui.openSession === 'function') {
            // openSession 内部会把会话 retain 到 mainView，本次引用可以安全释放。
            ui.openSession(sessionId);
          } else {
            // 没有 uiWorkspace 就保留引用：否则会话作用域被回收，刚发出的任务可能被中断。
            keepRetained = true;
          }
          await conversation.send(text);
        } finally {
          if (!keepRetained) reference.release();
        }
        return { sessionId, workspace };
      };
    }

    /** 在「会话作用域」上取服务：先试 retain 拿到的上下文，再退回 `sessions.scope(id)`。 */
    function readSessionService(sessions, binding, sessionId, name) {
      const candidates = [];
      if (binding !== undefined && binding.ctx !== undefined) candidates.push(binding.ctx);
      try {
        if (typeof sessions.scope === 'function') {
          const scoped = sessions.scope(sessionId);
          if (scoped !== undefined) candidates.push(scoped);
        }
      } catch {
        /* scope() 不可用就只用 binding.ctx */
      }
      for (const candidate of candidates) {
        const service = peekService(candidate, name);
        if (service !== undefined) return service;
      }
      return undefined;
    }

    /** 把一条禅道条目渲染成提示词里引用的 Markdown（有详情时把正文与附件一起带上）。 */
    function buildItemMarkdown(kind, item, server, detail) {
      const label = KIND_LABEL[kind] ?? kind;
      const source = detail === undefined || detail === null ? {} : detail;
      const lines = [`## 禅道${label} #${item.id}`, `- 标题：${item.title}`];
      const meta = [];
      if (source.statusLabel || item.statusLabel || item.status) meta.push(`状态：${source.statusLabel || item.statusLabel || item.status}`);
      if (source.assignedToName || item.assignedToName || item.assignedTo) meta.push(`指派给：${source.assignedToName || item.assignedToName || item.assignedTo}`);
      if (source.openedByName || item.openedBy) meta.push(`创建人：${source.openedByName || item.openedBy}`);
      if (item.deadline) meta.push(`截止：${item.deadline}`);
      if (item.severity !== undefined && String(item.severity) !== '') meta.push(`严重程度：${String(item.severity)}`);
      if (item.priority !== undefined && String(item.priority) !== '') meta.push(`优先级：${String(item.priority)}`);
      if (meta.length > 0) lines.push(`- ${meta.join('　')}`);
      if (server) lines.push(`- 原始链接：${server}/${kind}-view-${encodeURIComponent(item.id)}.html`);
      const story = source.story;
      if (story !== undefined && story !== null && story.title) lines.push(`- 所属研发需求：#${story.id} ${story.title}`);
      // 正文：优先用详情（列表行只有元数据，没有正文）。
      const description = source.description || item.description;
      if (description) lines.push('', '### 描述 / 重现步骤 / 研发需求', description);
      const files = Array.isArray(source.attachments) ? source.attachments : [];
      if (files.length > 0) {
        lines.push('', `### 附件（${files.length} 个）`);
        for (const file of files) lines.push(`- ${file.name || file.url || ''}`);
        lines.push('（图片/PDF 可在工作台里预览，Word/Excel/PPT 可点「用默认程序打开」；需要看内容就说一声。）');
      }
      return lines.join('\n');
    }

    /** 提示词里的「当前工作区」段：把本地目录写清楚，模型才会在该工作区里干活。 */
    function buildWorkspaceSection(workspace) {
      if (workspace === undefined || workspace === null) {
        return '\n\n## 当前工作区\n- 未识别到当前工作区，请先问我这次改动应该在哪个项目目录里进行。';
      }
      const lines = ['', '## 当前工作区', `- 名称：${workspace.title === undefined || workspace.title === '' ? '未命名项目' : workspace.title}`];
      if (workspace.path !== undefined && workspace.path !== '') lines.push(`- 路径：${workspace.path}`);
      lines.push('- 要求：本次分析与改动都在这个工作区内完成，不要切换到其它工作区或目录。');
      return lines.join('\n');
    }

    /**
     * 组装「处理」/「复制提示词」使用的完整提示词。
     * @param {string} kind - task / bug / story。
     * @param {object} item - 列表行。
     * @param {string} server - 禅道服务器地址（拼原始链接用）。
     * @param {object} workspace - 实际发送目标工作区。
     * @param {object} [detail] - `fetchDetail` 的结果（带正文与附件）。
     * @param {object} [analysis] - `analyze` 的结果（AI 预判，可空）。
     */
    function buildPrompt(kind, item, server, workspace, detail, analysis) {
      const clues = categoryClues(kind, item);
      const clueLines = [
        '',
        '## 线索（工作台按字段自动整理，只是线索，判断权在你）',
        `- 对象类型：${KIND_LABEL[kind] ?? kind}`,
        `- 工作台的初步猜测：${CATEGORY_LABEL[clues.guess]}`,
      ];
      for (const hit of clues.hits) clueLines.push(`- ${hit}`);
      const parts = [
        PROMPT_INTRO,
        '',
        buildItemMarkdown(kind, item, server, detail),
        clueLines.join('\n'),
      ];
      const analysisText = formatAnalysisText(analysis);
      if (analysisText !== '') parts.push('', analysisText);
      parts.push(buildWorkspaceSection(workspace));
      parts.push(`\n\n（可用 zentao 工具 action=detail kind=${kind} id=${item.id} 读取禅道完整详情；也可直接打开上面的原始链接。）`);
      return parts.join('\n');
    }

    /** 工作台浮层组件。 */
    function Workbench(props) {
      const handlePrompt = props.handlePrompt;
      const describeTarget = props.describeTarget;
      const listTargets = props.listTargets;
      const watchTarget = props.watchTarget;

      const [open, setOpen] = useState(true);
      const [target, setTarget] = useState(() => (typeof describeTarget === 'function' ? describeTarget() : undefined));
      const [config, setConfig] = useState(null);
      // 勾了「记住密码」：Token 过期时宿主会用密文自动重新登录，界面不必再让你重输。
      // 放在 form 里（而不是新增 state），避免打乱冒烟脚本按下标注入的预设。
      const [form, setForm] = useState({ server: '', account: '', password: '', token: '', rememberToken: false, rememberPassword: true });
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [toast, setToast] = useState('');
      const [tab, setTab] = useState('task');
      const [data, setData] = useState({ tasks: [], bugs: [], stories: [], scan: null, fetchedAt: '' });
      const [detail, setDetail] = useState(null);
      // 图片放大预览（点详情卡片里的缩略图）：{ name, url } 或 null。
      const [preview, setPreview] = useState(null);
      // 「完成」卡片：{ id, title, hours, comment } 或 null（hours/comment 是输入框里的字符串）。
      const [finishFor, setFinishFor] = useState(null);
      // 「指派」卡片：{ id, title, current, query } 或 null。
      const [assignFor, setAssignFor] = useState(null);
      // 可指派成员列表（第一次打开指派卡片时拉取）；null 表示还没拉过。
      const [users, setUsers] = useState(null);
      // 发送目标选择（用户 m03741「工作区说不定有多个」）：'' = 跟随当前工作区，否则是工作区 ID。
      // 刻意追加在**最后**（第 15 个 useState），免得改坏冒烟脚本里按下标注入的预设。
      const [pick, setPick] = useState('');
      // AI 预判结果缓存：键含服务器、账号、条目类别及列表内容；详情指纹防止发送过期预判。
      // { category, categoryLabel, confidence, headline, reason, steps, questions, provider, model }。
      // 同样追加在最后（第 16 个 useState），保持冒烟脚本按下标注入的预设不被打乱。
      const [analyses, setAnalyses] = useState({});
      // 后台渐进扫描进度：`{ done, total, pending }` 或 null（没在扫）。
      // 追加成第 17 个 useState，前面的下标约定保持不变。
      const [progress, setProgress] = useState(null);
      // 禅道 Token 失效（宿主回 unauthorized）：切回「需要重新登录」这个可恢复状态。
      // 追加成第 18 个 useState，前面的下标约定保持不变。
      const [authExpired, setAuthExpired] = useState(false);
      const toastTimer = useRef();
      /** authExpired 的 ref 镜像：给 useCallback / effect 里读最新值用。 */
      const authExpiredRef = useRef(false);
      authExpiredRef.current = authExpired;
      const actionLock = useRef('');
      const loadedScopes = useRef(new Set());
      const loadingScopes = useRef(new Map());
      const requestEpoch = useRef(0);
      const analysisRequests = useRef(new Map());
      const analysisEpoch = useRef(0);
      const identityRef = useRef('');
      const currentIdentity = JSON.stringify([config?.server ?? '', config?.account ?? '', config?.hasToken === true]);
      if (identityRef.current !== currentIdentity) {
        identityRef.current = currentIdentity;
        requestEpoch.current += 1;
        loadedScopes.current.clear();
        loadingScopes.current.clear();
        analysisRequests.current.clear();
      }

      /**
       * 本地快照：把最近一次成功的取数结果按 `服务器|账号` 存进 localStorage。
       * 目的：重启 DSH / 刷新页面后**先渲染旧数据**，再后台刷新（stale-while-revalidate），
       * 不必对着空列表等禅道那轮串行扫描。
       */
      const snapshotStore = typeof window !== 'undefined' && window.localStorage ? window.localStorage : undefined;
      const snapshotKey = (info) => (info === null || info === undefined ? '' : `dsh-zentao-workbench:snapshot:${info.server}|${info.account}`);
      const readSnapshot = (info) => {
        if (snapshotStore === undefined) return undefined;
        try {
          const raw = snapshotStore.getItem(snapshotKey(info));
          if (raw === null || raw === '') return undefined;
          const parsed = JSON.parse(raw);
          if (parsed === null || typeof parsed !== 'object' || parsed.v !== 1) return undefined;
          return parsed.data;
        } catch {
          return undefined;
        }
      };
      const dropSnapshot = (info) => {
        if (snapshotStore === undefined) return;
        try {
          snapshotStore.removeItem(snapshotKey(info));
        } catch {
          // localStorage 不可写（隐私模式等）时忽略：只是少了「秒开」，不影响功能。
        }
      };

      const showToast = useCallback((message) => {
        setToast(message);
        if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => {
          setToast('');
          toastTimer.current = undefined;
        }, 3000);
      }, []);

      useEffect(
        () => () => {
          if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
        },
        [],
      );

      // 工作区/会话快照会随用户在左侧切换项目而变化，订阅一次让「发送目标」提示保持实时。
      useEffect(() => {
        if (typeof describeTarget === 'function') setTarget(describeTarget());
        if (typeof watchTarget !== 'function') return undefined;
        return watchTarget(() => {
          if (typeof describeTarget === 'function') setTarget(describeTarget());
          // 选中的那个工作区被移除/改名时静默回到「跟随当前工作区」，不让发送目标悬空。
          setPick((prev) => {
            if (prev === '' || typeof listTargets !== 'function') return prev;
            return listTargets().some((item) => item.workspaceId === prev) ? prev : '';
          });
        });
      }, [describeTarget, listTargets, watchTarget]);

      // 预览 / 完成 / 指派 / 详情卡片打开时按 Esc 关闭：后开的层优先（预览 > 完成/指派 > 详情）。
      useEffect(() => {
        if (detail === null && preview === null && finishFor === null && assignFor === null) return undefined;
        const onKeyDown = (event) => {
          if (event === null || event.key !== 'Escape') return;
          if (preview !== null) setPreview(null);
          else if (finishFor !== null) setFinishFor(null);
          else if (assignFor !== null) setAssignFor(null);
          else setDetail(null);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [detail, preview, finishFor, assignFor]);

      /** 统一包裹一次 RPC 调用，负责 busy/error 状态。 */
      const run = useCallback(
        async (fn) => {
          setBusy(true);
          setError('');
          try {
            return await fn();
          } catch (reason) {
            // 登录失效是**可恢复状态**，不是错误：切回登录态并给一个「重新登录」入口，
            // 不要把技术细节糊成红色错误条（否则面板变成一个只能看、不能用的死界面）。
            if (reason instanceof Error && reason.code === 'unauthorized') {
              requestEpoch.current += 1;
              loadedScopes.current.clear();
              loadingScopes.current.clear();
              setProgress(null);
              authExpiredRef.current = true;
              setAuthExpired(true);
              setError('');
              return undefined;
            }
            setError(reason instanceof Error ? reason.message : String(reason));
            return undefined;
          } finally {
            setBusy(false);
          }
        },
        [],
      );

      /**
       * 轮询后台扫描进度：每 400 ms 取一次增量，扫完就停。
       * 用 requestEpoch 做失效判断——退出登录/换账号后不再回写。
       */
      const pollScanJobs = useCallback((jobs, epoch) => {
        const pending = new Map(jobs.map((job) => [job.kind, job]));
        setProgress({ done: 0, total: jobs.reduce((sum, job) => sum + (job.total ?? 0), 0), pending: pending.size });
        const tick = async () => {
          let rounds = 0;
          while (pending.size > 0 && rounds < 150) {
            rounds += 1;
            await new Promise((resolve) => window.setTimeout(resolve, 400));
            if (requestEpoch.current !== epoch) return;
            for (const [kind, job] of [...pending]) {
              let result;
              try {
                result = await callRpc('scanProgress', { jobId: job.id });
              } catch {
                pending.delete(kind);
                continue;
              }
              if (result === undefined) continue;
              if (requestEpoch.current !== epoch) return;
              const rows = kind === 'bugs' ? result.bugs : result.stories;
              const finished = result.finished === true || result.missing === true;
              // 扫描中只增不删：拿到空的分片不改界面，避免「先闪空再长出来」；扫完才接受空结果。
              if (Array.isArray(rows) && (rows.length > 0 || finished)) {
                setData((prev) => ({ ...prev, [kind]: sortByIdDesc(rows) }));
              }
              setProgress({ done: result.done ?? 0, total: result.total ?? 0, pending: pending.size });
              if (finished) pending.delete(kind);
            }
          }
          if (requestEpoch.current === epoch) setProgress(null);
        };
        void tick();
      }, []);

      const refresh = useCallback(
        async (scope, force = false) => {
          const actualScope = scope ?? 'all';
          const epoch = requestEpoch.current;
          const snapshot = await run(() => callRpc('refresh', { scope: actualScope, force: force === true }));
          if (snapshot !== undefined && epoch === requestEpoch.current) {
            // 刷新可能改变正文版本：让刷新前发出的分析作废（不写回），但**保留**已完成的预判 ——
            // 缓存键含条目内容，正文变了自然换键不再显示，没必要让用户为每次刷新重花一次模型调用。
            analysisEpoch.current += 1;
            analysisRequests.current.clear();
            // 宿主回带这次真的更新了哪些键（scopes）：只**合并**这些键，别把没拉的类别清空 ——
            // 否则按类别刷新/任务写操作后，另一个页签已加载的列表会变空，而 loadedScopes 认为它已加载、不会重拉。
            const filled = Array.isArray(snapshot.scopes) ? snapshot.scopes : ['tasks', 'bugs', 'stories'];
            // 渐进扫描：宿主没等扫完就返回了，按 jobId 轮询增量（边扫边显示）。
            const jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
            const scanning = new Set(jobs.map((job) => job.kind));
            setData((prev) => {
              const next = { ...prev, fetchedAt: snapshot.fetchedAt ?? prev.fetchedAt };
              if (filled.includes('tasks')) {
                next.tasks = snapshot.tasks ?? [];
                next.taskTotal = snapshot.taskTotal ?? next.tasks.length;
              }
              // 正在后台扫描的类别**保留旧数据**（否则列表会先闪空再一点点长出来）；
              // 扫描结果由轮询写回，扫完若真的为空才清空。
              if (filled.includes('bugs') && !scanning.has('bugs')) next.bugs = snapshot.bugs ?? [];
              if (filled.includes('stories') && !scanning.has('stories')) next.stories = snapshot.stories ?? [];
              if (snapshot.scan !== null && snapshot.scan !== undefined) next.scan = snapshot.scan;
              return next;
            });
            for (const key of filled) loadedScopes.current.add(key);
            if (actualScope === 'all') loadedScopes.current.add('tasks');
            setDetail(null);
            if (jobs.length > 0) pollScanJobs(jobs, epoch);
            else setProgress(null);
            setAuthExpired(false);
          }
          return snapshot;
        },
        [pollScanJobs, run],
      );

      // 数据一变就写快照（登录态、有内容才写），供下次打开「秒开」。
      useEffect(() => {
        if (snapshotStore === undefined || config === null || config.hasToken !== true) return;
        if (data.fetchedAt === '') return;
        try {
          snapshotStore.setItem(snapshotKey(config), JSON.stringify({ v: 1, at: Date.now(), data }));
        } catch {
          // 配额满/隐私模式：放弃秒开即可，不影响功能。
        }
      }, [config, data]);

      const refreshForTab = useCallback(
        async (kind, force = false) => {
          // 登录已失效时不要自动重试：等用户重新登录，否则会反复撞 401。
          if (authExpiredRef.current) return undefined;
          // 按页签只取自己需要的那一类：Bug 页不再白等需求的扫描（实测每类 ~10 个请求）。
          const scope = kind === 'bug' ? 'bugs' : kind === 'story' ? 'stories' : 'tasks';
          // force=true 用于「刷新」按钮：用户明确要求重拉，即使这个 scope 已经加载过。
          if (!force && loadedScopes.current.has(scope)) return;
          const epoch = requestEpoch.current;
          const pending = loadingScopes.current.get(scope);
          if (pending !== undefined) return pending;
          const promise = (async () => {
            try {
              if (scope !== 'tasks') {
                const tasksPending = loadingScopes.current.get('tasks');
                if (tasksPending !== undefined) await tasksPending;
                if (requestEpoch.current !== epoch) return undefined;
              }
              const snapshot = await refresh(scope, force);
              if (requestEpoch.current !== epoch) return undefined;
              return snapshot;
            } finally {
              if (loadingScopes.current.get(scope) === promise) loadingScopes.current.delete(scope);
            }
          })();
          loadingScopes.current.set(scope, promise);
          return promise;
        },
        [refresh],
      );

      // 启动：读配置；已登录则先只拉任务（快），Bug/需求按需拉。
      useEffect(() => {
        let cancelled = false;
        (async () => {
          const info = await run(() => callRpc('getConfig', {}));
          if (cancelled || info === undefined) return;
          identityRef.current = JSON.stringify([info.server ?? '', info.account ?? '', info.hasToken === true]);
          setConfig(info);
          setForm((prev) => ({ ...prev, server: info.server, account: info.account }));
          // 先渲染上次的快照（秒开），随后照常刷新覆盖它：stale-while-revalidate。
          const restored = readSnapshot(info);
          if (restored !== undefined && info.hasToken) setData(restored);
          if (info.hasToken) await refreshForTab('task');
        })();
        return () => {
          cancelled = true;
        };
        // 只在挂载时执行一次。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      useEffect(() => {
        if (config === null || config.hasToken !== true) return;
        void refreshForTab(tab);
      }, [config, refreshForTab, tab]);

      const doLogin = useCallback(async () => {
        const info = await run(() =>
          callRpc('login', {
            server: form.server,
            account: form.account,
            password: form.password,
            token: form.token,
            rememberToken: form.rememberToken,
            rememberPassword: form.rememberPassword === true,
          }),
        );
        if (info === undefined) return;
        requestEpoch.current += 1;
        analysisEpoch.current += 1;
        identityRef.current = JSON.stringify([info.server ?? '', info.account ?? '', info.hasToken === true]);
        setConfig(info);
        loadedScopes.current.clear();
        loadingScopes.current.clear();
        analysisRequests.current.clear();
        setAnalyses({});
        setAuthExpired(false);
        authExpiredRef.current = false;
        setForm((prev) => ({ ...prev, password: '', token: '' }));
        setData({ tasks: [], bugs: [], stories: [], scan: null, fetchedAt: '' });
        showToast(`已登录：${info.realname || info.account}`);
        await refreshForTab('task');
      }, [form, refreshForTab, run, showToast]);

      /** 清除本机保存的密码（之后 Token 过期就只能手动重新登录）。 */
      const doForgetPassword = useCallback(async () => {
        const info = await run(() => callRpc('forgetPassword', {}));
        if (info === undefined) return;
        setConfig(info);
        showToast('已清除本机保存的密码');
      }, [run, showToast]);

      const doLogout = useCallback(async () => {
        const previous = config;
        const info = await run(() => callRpc('logout', {}));
        if (info === undefined) return;
        requestEpoch.current += 1;
        analysisEpoch.current += 1;
        identityRef.current = JSON.stringify([info.server ?? '', info.account ?? '', info.hasToken === true]);
        setConfig(info);
        loadedScopes.current.clear();
        loadingScopes.current.clear();
        analysisRequests.current.clear();
        setAnalyses({});
        setProgress(null);
        dropSnapshot(previous);
        setData({ tasks: [], bugs: [], stories: [], scan: null, fetchedAt: '', taskTotal: 0 });
        setDetail(null);
        showToast('已退出禅道登录');
      }, [config, run, showToast]);

      const openDetail = useCallback(
        async (kind, item) => {
          const key = `${kind}-${item.id}`;
          if (detail !== null && detail.key === key) {
            setDetail(null);
            return;
          }
          const result = await run(() => callRpc('fetchDetail', { kind, id: item.id }));
          if (result !== undefined) setDetail({ key, data: result });
        },
        [detail, run],
      );

      // 发送目标：下拉里选过就用选的，没选就跟随主面板当前工作区（工作区可能有多个，用户 m03741）。
      const workspaceList = typeof listTargets === 'function' ? listTargets() : [];
      const targets = Array.isArray(workspaceList) ? workspaceList : [];
      const chosen = pick === '' ? target : (targets.find((item) => item.workspaceId === pick) ?? target);
      const chosenLabel = chosen === undefined || chosen === null ? '' : describeWorkspace(chosen);
      const targetLabel = target === undefined || target === null ? '' : describeWorkspace(target);
      // 只有一个工作区时不给下拉（省版面），但加一句说明，让人知道这里是「工作区」而不是写死的目标。
      const pickSuffix =
        targets.length > 1 ? (pick === '' ? '（跟随当前工作区）' : '') : targets.length === 1 ? '（当前只有 1 个工作区）' : '';

      /** 预判结果在 analyses 里的键。 */
      const analysisKey = (kind, item) => {
        return JSON.stringify([config?.server ?? '', config?.account ?? '', kind, item]);
      };

      // 组装提示词前先把详情拉下来：正文（研发需求 / 重现步骤）与附件都在详情里，
      // 列表行只有元数据 —— 不拉的话提示词里就没有正文（用户 m04648 的疑问）。
      const promptFor = useCallback(
        async (kind, item) => {
          const server = config === null ? '' : config.server;
          const epoch = requestEpoch.current;
          let detailData;
          try {
            detailData = await callRpc('fetchDetail', { kind, id: item.id });
          } catch (reason) {
            throw new Error(`读取条目 #${item.id} 详情失败，未发送不完整的提示词：${reason instanceof Error ? reason.message : String(reason)}`);
          }
          if (requestEpoch.current !== epoch) throw new Error('登录状态已变化，请重新读取条目后处理');
          const analysis = analyses[analysisKey(kind, item)];
          const validAnalysis = analysis?.contentFingerprint !== undefined && analysis.contentFingerprint === detailData?.contentFingerprint ? analysis : undefined;
          return buildPrompt(kind, item, server, chosen, detailData, validAnalysis);
        },
        [analyses, chosen, config],
      );

      const doHandle = useCallback(
        async (kind, item) => {
          const lockKey = `handle-${kind}-${item.id}`;
          if (actionLock.current !== '') return;
          actionLock.current = lockKey;
          try {
            // 提示词抬头与类别套路都在 buildPrompt 里（用户 m04648：先判类别、再按类别走套路）。
            const prompt = await promptFor(kind, item);
            try {
              const result = await handlePrompt(prompt, pick);
              const title = result !== undefined && result.workspace !== undefined && result.workspace.title ? result.workspace.title : '当前工作区';
              showToast(`已在「${title}」新建会话并自动发送提示词`);
              setOpen(false);
            } catch (reason) {
              const ok = await copyText(prompt);
              showToast(
                ok
                  ? `自动执行失败（${reason instanceof Error ? reason.message : String(reason)}），提示词已复制，粘贴发送即可`
                  : '自动执行失败且复制失败，请手动重试',
              );
              return;
            }
            if (kind !== 'task') return;
            try {
              const started = await callRpc('startTask', { id: item.id });
              if (started !== undefined && started.changed === true) {
                showToast(`任务 #${item.id} 已置为「${started.statusLabel || started.status}」`);
                await refresh('tasks');
              } else if (started !== undefined) {
                showToast(`任务 #${item.id} 状态未变：${started.note || started.statusLabel || started.status}`);
              }
            } catch (reason) {
              showToast(`任务置为「开始」失败：${reason instanceof Error ? reason.message : String(reason)}`);
            }
          } catch (reason) {
            showToast(reason instanceof Error ? reason.message : String(reason));
          } finally {
            actionLock.current = '';
          }
        },
        [handlePrompt, pick, promptFor, refresh, showToast],
      );

      const doCopy = useCallback(
        async (kind, item) => {
          try {
            const ok = await copyText(await promptFor(kind, item));
            showToast(ok ? '提示词已复制（含正文、附件与发送目标工作区）' : '复制失败，请手动选择文本');
          } catch (reason) {
            showToast(reason instanceof Error ? reason.message : String(reason));
          }
        },
        [promptFor, showToast],
      );

      /**
       * AI 预判：让宿主用当前模型判一次这是 Bug / 优化 / 需求（用户 m04648 选的 C 方案）。
       * 结果缓存在 analyses 里：列表行下方展示，之后「处理」/「复制提示词」会把它一起带上。
       */
      const doAnalyze = useCallback(
        async (kind, item) => {
          const key = analysisKey(kind, item);
          const epoch = requestEpoch.current;
          const cacheEpoch = analysisEpoch.current;
          const pending = analysisRequests.current.get(key);
          if (pending !== undefined) return pending;
          const promise = (async () => {
            try {
              const result = await run(() => callRpc('analyze', { kind, id: item.id }));
              if (result === undefined || requestEpoch.current !== epoch || analysisEpoch.current !== cacheEpoch || analysisKey(kind, item) !== key) return;
              setAnalyses((prev) => ({ ...prev, [key]: result }));
              const label = result.categoryLabel || CATEGORY_LABEL[result.category] || result.category;
              const score = result.confidence === null || result.confidence === undefined ? '' : `（置信度 ${result.confidence}）`;
              showToast(`AI 预判：${label}${score}`);
              return result;
            } finally {
              if (analysisRequests.current.get(key) === promise) analysisRequests.current.delete(key);
            }
          })();
          analysisRequests.current.set(key, promise);
          return promise;
        },
        [run, showToast],
      );

      const loggedIn = config !== null && config.hasToken === true;

      /** 打开「完成」卡片：先关掉其它浮层，避免几张卡片叠在一起。 */
      const openFinish = useCallback((item) => {
        setDetail(null);
        setAssignFor(null);
        setFinishFor({ id: item.id, title: item.title, hours: '', comment: '' });
      }, []);

      /** 拉一次可指派成员列表（第一次打开指派卡片时用；失败只改红色提示条）。 */
      const loadUsers = useCallback(async () => {
        const result = await run(() => callRpc('listUsers', {}));
        if (result !== undefined) setUsers(Array.isArray(result.users) ? result.users : []);
      }, [run]);

      /** 打开「指派」卡片，并确保成员列表已加载。 */
      const openAssign = useCallback(
        async (item) => {
          setDetail(null);
          setFinishFor(null);
          setAssignFor({
            id: item.id,
            title: item.title,
            current: item.assignedToName || item.assignedTo || '（未指派）',
            query: '',
          });
          if (users === null) await loadUsers();
        },
        [loadUsers, users],
      );

      /**
       * 完成任务：耗时（小时）由用户在卡片里填，`realStarted` / `finishedDate` 这两个禅道必填项
       * 由宿主补齐；写完后端会回读状态，所以这里以返回的 `changed` 为准，不谎报成功。
       */
      const doFinish = useCallback(async () => {
        if (finishFor === null) return;
        const form = finishFor;
        const hours = form.hours.trim() === '' ? 0 : Number(form.hours);
        if (!Number.isFinite(hours) || hours < 0) {
          showToast('耗时（小时）必须是不小于 0 的数字');
          return;
        }
        const result = await run(() => callRpc('finishTask', { id: form.id, hours, comment: form.comment }));
        if (result === undefined) {
          showToast('完成任务失败，原因见上方红色提示');
          return;
        }
        setFinishFor(null);
        showToast(
          result.changed === true
            ? `任务 #${form.id} 已完成（${result.statusLabel || result.status}），累计耗时 ${result.consumed} 小时`
            : `任务 #${form.id} 状态未变：${result.note || result.statusLabel || result.status}`,
        );
        if (result.changed === true) await refresh('tasks');
      }, [finishFor, refresh, run, showToast]);

      /** 指派任务：禅道用 `PUT tasks/{id}` + `{"assignedTo"}`，未开始的任务会被激活为「进行中」。 */
      const doAssign = useCallback(
        async (user) => {
          if (assignFor === null) return;
          const form = assignFor;
          const result = await run(() => callRpc('assignTask', { id: form.id, account: user.account }));
          if (result === undefined) {
            showToast('指派失败，原因见上方红色提示');
            return;
          }
          setAssignFor(null);
          const tail = result.statusChanged === true ? `；任务状态变为「${result.statusLabel || result.status}」` : '';
          showToast(
            result.changed === true
              ? `任务 #${form.id} 已指派给「${result.realname || user.realname}」${tail}`
              : `任务 #${form.id} 未变：${result.note}`,
          );
          if (result.changed === true) await refresh('tasks');
        },
        [assignFor, refresh, run, showToast],
      );

      /**
       * 用电脑上的默认程序打开附件（Word / Excel / WPS / 系统 PDF 阅读器…）。
       * 禅道附件必须先由宿主持 Token 下载到本机，浏览器没法直接调起本地程序。
       */
      const openWithDefault = useCallback(
        async (file) => {
          const name = file.name === undefined || file.name === '' ? '（未命名附件）' : file.name;
          const result = await run(() => callRpc('openAttachment', { url: file.url || file.proxyUrl, name }));
          if (result === undefined) {
            showToast('打开附件失败，原因见上方红色提示');
            return;
          }
          showToast(`已交给系统默认程序打开：${result.name || name}`);
        },
        [run, showToast],
      );

      const list = sortByIdDesc(data[KIND_LIST[tab] ?? tab] ?? []);

      const itemNode = (item) => {
        const key = `${tab}-${item.id}`;
        const analysis = analyses[analysisKey(tab, item)];
        const node = h(
          'div',
          { className: 'dzw-item', key },
          h(
            'div',
            { className: 'dzw-item-head' },
            h('span', { className: 'dzw-item-title', onClick: () => void openDetail(tab, item), title: '点击查看详情' }, `#${item.id} ${item.title}`),
          ),
          h(
            'div',
            { className: 'dzw-meta' },
            item.status ? h('span', null, item.statusLabel || item.status) : null,
            item.assignedToName || item.assignedTo ? h('span', null, `@${item.assignedToName || item.assignedTo}`) : null,
            item.deadline ? h('span', null, `截止 ${item.deadline}`) : null,
          ),
          h(
            'div',
            { className: 'dzw-actions' },
            h(
              'button',
              {
                className: 'dzw-btn primary',
                onClick: () => void doHandle(tab, item),
                disabled: busy,
                title: tab === 'task' && item.status === 'wait' ? '新建会话并自动发送提示词；任务会同时置为「开始」' : '新建会话并自动发送提示词',
              },
              '处理',
            ),
            h(
              'button',
              {
                className: 'dzw-btn',
                onClick: () => void doAnalyze(tab, item),
                disabled: busy,
                title: '用当前模型先判一次这是 Bug / 优化 / 需求，并给出处理步骤；结果会自动带进提示词',
              },
              analysis === undefined ? 'AI 分析' : '重新分析',
            ),
            tab === 'task'
              ? h(
                  'button',
                  {
                    className: 'dzw-btn',
                    onClick: () => openFinish(item),
                    disabled: busy || item.status === 'done' || item.status === 'closed',
                    title:
                      item.status === 'done' || item.status === 'closed'
                        ? `任务已经是「${item.statusLabel || item.status}」，不用再完成`
                        : '完成任务并登记本次耗时（小时）',
                  },
                  '完成',
                )
              : null,
            tab === 'task'
              ? h(
                  'button',
                  {
                    className: 'dzw-btn',
                    onClick: () => void openAssign(item),
                    disabled: busy,
                    title: '把任务指派给别人（禅道会把未开始的任务激活为「进行中」）',
                  },
                  '指派',
                )
              : null,
            h('button', { className: 'dzw-btn', onClick: () => void doCopy(tab, item) }, '复制提示词'),
            config !== null && config.server
              ? h(
                  'a',
                  {
                    className: 'dzw-link',
                    href: `${config.server}/${tab}-view-${encodeURIComponent(item.id)}.html`,
                    target: '_blank',
                    rel: 'noreferrer',
                    style: { alignSelf: 'center' },
                  },
                  '原始链接',
                )
              : null,
          ),
          analysis === undefined
            ? null
            : h(
                'div',
                { className: 'dzw-analysis' },
                h(
                  'div',
                  { className: 'dzw-analysis-head' },
                  h('span', { className: 'dzw-analysis-tag' }, analysis.categoryLabel || CATEGORY_LABEL[analysis.category] || analysis.category),
                  analysis.confidence === null || analysis.confidence === undefined ? null : h('span', null, `置信度 ${analysis.confidence}`),
                  h(
                    'span',
                    { className: 'dzw-analysis-model' },
                    `${analysis.provider || ''}/${analysis.model || ''}${analysis.routeSource === 'dsh' ? '（DSH 默认模型）' : analysis.routeSource === 'env' ? '（环境变量指定）' : '（自动挑选）'}${analysis.truncated ? '，输出可能被截断' : ''}`,
                  ),
                ),
                analysis.routeNote ? h('div', { className: 'dzw-analysis-note' }, analysis.routeNote) : null,
                analysis.headline ? h('div', { className: 'dzw-analysis-line' }, analysis.headline) : null,
                analysis.reason ? h('div', { className: 'dzw-analysis-why' }, `依据：${analysis.reason}`) : null,
                Array.isArray(analysis.steps) && analysis.steps.length > 0
                  ? h(
                      'ul',
                      { className: 'dzw-analysis-steps' },
                      analysis.steps.map((step, index) => h('li', { key: `step-${index}` }, step)),
                    )
                  : null,
                Array.isArray(analysis.questions) && analysis.questions.length > 0
                  ? h('div', { className: 'dzw-analysis-why' }, `待确认：${analysis.questions.join('；')}`)
                  : null,
              ),
        );
        return node;
      };

      /**
       * 详情悬浮卡片：点标题后浮在面板左侧，不铺全屏遮罩（不压暗界面、不拦截其它点击）。
       * 关闭：标题再点一次 / 关闭按钮 / Esc。
       * 正文按宿主返回的 sections（描述 / 步骤 / 重现步骤）分段展示，图片附件直接出缩略图。
       */
      const detailModal = () => {
        if (detail === null) return null;
        const info = detail.data;
        const sections = Array.isArray(info.sections) ? info.sections : [];
        const attachments = Array.isArray(info.attachments) ? info.attachments : [];
        const kind = detail.key.slice(0, detail.key.lastIndexOf('-'));
        // 附件直链在浏览器里会撞上禅道登录页，所以优先用宿主代理地址。
        const href = (file) => file.proxyUrl || file.url;
        /** 单个附件：图片出缩略图（点开大图）、视频出播放器（点开大播放）、其它给链接。 */
        const attachmentNode = (file, index) => {
          const name = file.name === '' || file.name === undefined ? '（未命名附件）' : file.name;
          if (isImageAttachment(file)) {
            return h(
              'div',
              { key: `a${index}`, className: 'dzw-attach-item' },
              h(
                'div',
                { className: 'dzw-attach-head' },
                h(
                  'a',
                  { className: 'dzw-link', href: href(file), target: '_blank', rel: 'noreferrer', title: '在新窗口打开原图' },
                  name,
                ),
                h(
                  'button',
                  {
                    className: 'dzw-link dzw-zoom',
                    onClick: () => setPreview({ name, url: href(file), kind: 'image' }),
                    title: '点击放大预览',
                  },
                  '放大',
                ),
              ),
              h(
                'button',
                {
                  className: 'dzw-thumb-link',
                  onClick: () => setPreview({ name, url: href(file), kind: 'image' }),
                  title: '点击放大预览',
                },
                h('img', { className: 'dzw-thumb', src: href(file), alt: name, loading: 'lazy' }),
              ),
            );
          }
          if (isVideoAttachment(file)) {
            return h(
              'div',
              { key: `a${index}`, className: 'dzw-attach-item' },
              h(
                'div',
                { className: 'dzw-attach-head' },
                h(
                  'a',
                  { className: 'dzw-link', href: href(file), target: '_blank', rel: 'noreferrer', title: '在新窗口打开原视频' },
                  name,
                ),
                h(
                  'button',
                  {
                    className: 'dzw-link dzw-zoom',
                    onClick: () => setPreview({ name, url: href(file), kind: 'video' }),
                    title: '点击放大播放',
                  },
                  '放大播放',
                ),
              ),
              h('video', {
                className: 'dzw-video',
                src: href(file),
                controls: true,
                preload: 'metadata',
                playsInline: true,
              }),
            );
          }
          if (isPdfAttachment(file)) {
            return h(
              'div',
              { key: `a${index}`, className: 'dzw-attach-item' },
              h(
                'div',
                { className: 'dzw-attach-head' },
                h(
                  'a',
                  { className: 'dzw-link', href: href(file), target: '_blank', rel: 'noreferrer', title: '在新窗口打开 PDF' },
                  name,
                ),
                h(
                  'button',
                  {
                    className: 'dzw-link dzw-zoom',
                    onClick: () => setPreview({ name, url: href(file), kind: 'pdf' }),
                    title: '在工作台里预览 PDF',
                  },
                  '预览 PDF',
                ),
              ),
            );
          }
          if (isOfficeAttachment(file)) {
            return h(
              'div',
              { key: `a${index}`, className: 'dzw-attach-item' },
              h(
                'div',
                { className: 'dzw-attach-head' },
                h(
                  'a',
                  { className: 'dzw-link', href: href(file), target: '_blank', rel: 'noreferrer', title: '在新窗口打开（走宿主代理，可能需要登录态）' },
                  name,
                ),
                h(
                  'button',
                  {
                    className: 'dzw-link dzw-zoom',
                    onClick: () => void openWithDefault(file),
                    title: '下载到本机并用电脑的默认程序打开（Word / Excel / WPS）',
                  },
                  '用默认程序打开',
                ),
              ),
            );
          }
          return h(
            'a',
            { key: `a${index}`, className: 'dzw-link', href: href(file), target: '_blank', rel: 'noreferrer' },
            name,
          );
        };
        return h(
          'div',
          { className: 'dzw-modal', key: 'detail-modal' },
            h(
              'div',
              { className: 'dzw-modal-head' },
              h('span', { className: 'dzw-modal-title' }, `#${info.id} ${info.title}`),
              h('button', { className: 'dzw-modal-close', onClick: () => setDetail(null), title: '关闭（Esc）' }, '关闭'),
            ),
            h(
              'div',
              { className: 'dzw-modal-body' },
              h(
                'div',
                { className: 'dzw-meta' },
                info.status ? h('span', null, `状态：${info.statusLabel || info.status}`) : null,
                info.assignedTo || info.assignedToName ? h('span', null, `指派给：${info.assignedToName || info.assignedTo}`) : null,
                info.openedBy || info.openedByName ? h('span', null, `创建人：${info.openedByName || info.openedBy}`) : null,
                info.deadline ? h('span', null, `截止：${info.deadline}`) : null,
                info.fromBug ? h('span', null, `来源 Bug：#${info.fromBug}`) : null,
                // 任务常挂在一条研发需求上（`storyID` / `storyTitle` / `storySpec`），
                // 点这条能直接跳去禅道的需求页看原文。
                info.story && info.story.id
                  ? h(
                      'a',
                      {
                        className: 'dzw-link',
                        href: info.story.link || '#',
                        target: '_blank',
                        rel: 'noreferrer',
                        title: '在禅道中打开这条研发需求',
                      },
                      `研发需求：#${info.story.id} ${info.story.title}${info.story.statusLabel ? `（${info.story.statusLabel}）` : ''}`,
                    )
                  : null,
              ),
              // 宿主把详情里的散字段整理成 meta（所属执行 / 类型 / 工时 / 严重程度 / 解决方案…），
              // 弹窗里逐条显示，避免「有内容却看不到」。
              Array.isArray(info.meta) && info.meta.length > 0
                ? h(
                    'div',
                    { className: 'dzw-meta' },
                    info.meta.map((row, index) => h('span', { key: `m${index}` }, `${row.label}：${row.value}`)),
                  )
                : null,
              sections.length > 0
                ? sections.map((section, index) => {
                    // 正文里的 [附件] 行已经在下面的附件区列出，这里不再重复显示。
                    const text = String(section.text ?? '')
                      .split('\n')
                      .filter((line) => !line.trim().startsWith('[附件]'))
                      .join('\n')
                      .trim();
                    if (text === '') return null;
                    return h(
                      'div',
                      { className: 'dzw-section', key: `s${index}` },
                      h('div', { className: 'dzw-section-label' }, section.label),
                      h('pre', null, text),
                    );
                  })
                : h('div', { className: 'dzw-empty' }, '（详情里没有描述 / 研发需求描述 / 步骤正文）'),
              attachments.length > 0
                ? h(
                    'div',
                    { className: 'dzw-section' },
                    h('div', { className: 'dzw-section-label' }, `附件（${attachments.length}）`),
                    h(
                      'div',
                      { className: 'dzw-attach' },
                      attachments.map((file, index) => attachmentNode(file, index)),
                    ),
                  )
                : null,
              info.actions && info.actions.length > 0
                ? h(
                    'ul',
                    { className: 'dzw-hist' },
                    info.actions.map((action, index) =>
                      h(
                        'li',
                        { key: `h${index}` },
                        `${action.date} ${action.actor} ${action.actionLabel || action.action}${action.comment ? ` — ${action.comment}` : ''}`,
                      ),
                    ),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'dzw-modal-foot' },
              h('span', null, `${KIND_LABEL[kind] ?? kind}　来自禅道接口`),
              info.link ? h('a', { className: 'dzw-link', href: info.link, target: '_blank', rel: 'noreferrer', style: { marginLeft: 'auto' } }, '在禅道中打开') : null,
            ),
        );
      };

      /**
       * 附件放大预览（图片 / 视频通用）：透明点击层 + 居中悬浮卡片（不铺灰底），
       * 点空白处 / 点两个「关闭」按钮之一 / 按 Esc 都能关掉。不写禅道数据，纯前端。
       */
      const previewOverlay = () => {
        if (preview === null) return null;
        const stopPropagation = (event) => {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        };
        const close = () => setPreview(null);
        const kind = preview.kind === 'video' || preview.kind === 'pdf' ? preview.kind : 'image';
        const isVideo = kind === 'video';
        const isPdf = kind === 'pdf';
        const openTitle = isVideo ? '在新窗口打开原视频' : isPdf ? '在新窗口打开 PDF' : '在新窗口打开原图';
        return h(
          'div',
          { className: 'dzw-preview', key: 'dzw-preview', onClick: close },
          // 关闭按钮放在视口右上角固定位置（不跟着图片大小跑），带底色 + ✕ 图标，一眼能看见。
          h(
            'button',
            { className: 'dzw-preview-close dzw-preview-close-float', onClick: close, title: '关闭预览（Esc）' },
            h('span', { className: 'dzw-preview-x' }, '✕'),
            '关闭',
          ),
          h(
            'div',
            { className: 'dzw-preview-card', onClick: stopPropagation },
            h(
              'div',
              { className: 'dzw-preview-head' },
              h('span', { className: 'dzw-preview-name' }, preview.name),
              h(
                'a',
                { className: 'dzw-link', href: preview.url, target: '_blank', rel: 'noreferrer', title: openTitle },
                '新窗口打开',
              ),
            ),
            isVideo
              ? h('video', {
                  className: 'dzw-preview-video',
                  src: preview.url,
                  controls: true,
                  // 不自动播放：点一下卡片里的播放键才播（用户明确要求「点击才播放」）。
                  preload: 'metadata',
                  playsInline: true,
                })
              : isPdf
                ? h('iframe', {
                    className: 'dzw-preview-pdf',
                    src: preview.url,
                    title: preview.name,
                  })
                : h('img', { className: 'dzw-preview-img', src: preview.url, alt: preview.name }),
            h(
              'div',
              { className: 'dzw-preview-foot' },
              h(
                'span',
                { className: 'dzw-preview-hint' },
                isVideo ? '点播放键开始播放；点空白处或按 Esc 关闭' : '点空白处或按 Esc 也能关闭',
              ),
              h(
                'button',
                { className: 'dzw-preview-close dzw-preview-close-solid', onClick: close, title: '关闭预览（Esc）' },
                h('span', { className: 'dzw-preview-x' }, '✕'),
                '关闭',
              ),
            ),
          ),
        );
      };

      /**
       * 「完成」悬浮卡片：填本次耗时（小时）和可选备注，提交 `POST tasks/{id}/finish`。
       * 禅道必填的 `realStarted` / `finishedDate` 由宿主补齐（任务没开始过就用今天）。
       */
      const finishCard = () => {
        if (finishFor === null) return null;
        return h(
          'div',
          { className: 'dzw-modal', key: 'finish-modal' },
          h(
            'div',
            { className: 'dzw-modal-head' },
            h('span', { className: 'dzw-modal-title' }, `完成任务 #${finishFor.id}`),
            h('button', { className: 'dzw-modal-close', onClick: () => setFinishFor(null), title: '关闭（Esc）' }, '关闭'),
          ),
          h(
            'div',
            { className: 'dzw-modal-body' },
            h('div', { className: 'dzw-hint' }, finishFor.title),
            h(
              'div',
              { className: 'dzw-field' },
              h('label', null, '本次耗时（小时）'),
              h('input', {
                className: 'dzw-input',
                type: 'number',
                min: '0',
                step: '0.5',
                placeholder: '例如 0.5 / 2 / 8，留空按 0 算',
                value: finishFor.hours,
                onChange: (event) =>
                  setFinishFor((prev) => (prev === null ? prev : { ...prev, hours: event.target.value })),
              }),
            ),
            h(
              'div',
              { className: 'dzw-field' },
              h('label', null, '备注（可选，会写进禅道历史）'),
              h('textarea', {
                className: 'dzw-input dzw-textarea',
                rows: '3',
                placeholder: '例如：功能已自测通过，代码已合并到 master',
                value: finishFor.comment,
                onChange: (event) =>
                  setFinishFor((prev) => (prev === null ? prev : { ...prev, comment: event.target.value })),
              }),
            ),
            h('div', { className: 'dzw-hint' }, '提交后任务状态变为「已完成」；累计耗时 = 已登记耗时 + 本次耗时。'),
          ),
          h(
            'div',
            { className: 'dzw-modal-foot' },
            h('button', { className: 'dzw-btn primary', onClick: () => void doFinish(), disabled: busy }, busy ? '提交中…' : '确认完成'),
            h('button', { className: 'dzw-btn', onClick: () => setFinishFor(null) }, '取消'),
          ),
        );
      };

      /**
       * 「指派」悬浮卡片：搜姓名/账号，点一行即指派（禅道用 `PUT tasks/{id}` 实现）。
       * 未开始的任务被指派后会激活成「进行中」，卡片里有明确提示。
       */
      const assignCard = () => {
        if (assignFor === null) return null;
        const query = assignFor.query.trim().toLowerCase();
        const all = Array.isArray(users) ? users : [];
        const matched =
          query === '' ? all : all.filter((user) => `${user.realname} ${user.account}`.toLowerCase().includes(query));
        return h(
          'div',
          { className: 'dzw-modal', key: 'assign-modal' },
          h(
            'div',
            { className: 'dzw-modal-head' },
            h('span', { className: 'dzw-modal-title' }, `指派任务 #${assignFor.id}`),
            h('button', { className: 'dzw-modal-close', onClick: () => setAssignFor(null), title: '关闭（Esc）' }, '关闭'),
          ),
          h(
            'div',
            { className: 'dzw-modal-body' },
            h('div', { className: 'dzw-hint' }, `当前指派给：${assignFor.current}`),
            h('input', {
              className: 'dzw-input',
              placeholder: '搜姓名或账号',
              value: assignFor.query,
              onChange: (event) => setAssignFor((prev) => (prev === null ? prev : { ...prev, query: event.target.value })),
            }),
            h('div', { className: 'dzw-hint', style: { margin: '8px 0' } }, '提示：禅道在把未开始的任务指派出去时，会把任务激活为「进行中」。'),
            users === null
              ? h('div', { className: 'dzw-empty' }, busy ? '正在读取成员列表…' : '（成员列表还没加载，点「刷新成员」重试）')
              : matched.length === 0
                ? h('div', { className: 'dzw-empty' }, '没有匹配的成员')
                : h(
                    'div',
                    { className: 'dzw-user-list' },
                    matched.map((user) =>
                      h(
                        'button',
                        {
                          key: user.account,
                          className: 'dzw-user',
                          onClick: () => void doAssign(user),
                          disabled: busy,
                          title: `指派给 ${user.realname}（${user.account}）`,
                        },
                        h('span', { className: 'dzw-user-name' }, user.realname),
                        h('span', { className: 'dzw-user-account' }, user.account),
                      ),
                    ),
                  ),
          ),
          h(
            'div',
            { className: 'dzw-modal-foot' },
            h('button', { className: 'dzw-btn', onClick: () => void loadUsers(), disabled: busy }, '刷新成员'),
            h('button', { className: 'dzw-btn', onClick: () => setAssignFor(null) }, '取消'),
          ),
        );
      };

      if (!open) {
        return h(
          'div',
          { className: 'dzw-root' },
          h(
            'button',
            { className: 'dzw-launcher', onClick: () => setOpen(true), title: '禅道工作台' },
            '禅',
            h('span', { className: `dzw-dot ${loggedIn ? 'on' : 'off'}` }),
          ),
          previewOverlay(),
          finishCard(),
          assignCard(),
        );
      }

      const tabButton = (id) => {
        const key = KIND_LIST[id] ?? id;
        // 还没有任何数据、也还没加载过时才显示「…」：Bug/需求要按产品聚合，
        // 先显示 0 会让人以为「一条都没有」；但若从本地快照恢复了旧数据，就直接显示条数。
        const pending = loggedIn && !loadedScopes.current.has(key) && (data[key] ?? []).length === 0;
        const count = (data[key] ?? []).length;
        return h(
          'button',
          { key: id, className: `dzw-tab ${tab === id ? 'active' : ''}`, onClick: () => setTab(id) },
          `${KIND_LABEL[id]}（${pending ? '…' : count}）`,
        );
      };

      return h(
        'div',
        { className: 'dzw-root' },
        h(
          'div',
          { className: 'dzw-panel' },
          h(
            'div',
            { className: 'dzw-head' },
            h('span', { className: 'dzw-title' }, '禅道工作台'),
            h('span', { className: 'dzw-sub' }, loggedIn ? config.realname || config.account : '未登录'),
            // 刷新只拉当前页签需要的东西：任务页只打一次 tasks（实测 ~0.2 s），
            // 只有 Bug/需求页才做逐产品的全量聚合（实测 ~2 s）。
            h(
              'button',
              {
                className: 'dzw-icon',
                onClick: () => void refreshForTab(tab, true),
                disabled: busy || !loggedIn || authExpired,
                title:
                  tab === 'task'
                    ? '刷新任务（单个请求，最快）'
                    : `刷新${KIND_LABEL[tab]}（需逐产品聚合，约 10 个请求；2 分钟内的重复刷新直接吃宿主缓存）`,
              },
              busy ? '…' : '刷新',
            ),
            h('button', { className: 'dzw-icon', onClick: () => { setDetail(null); setFinishFor(null); setAssignFor(null); setPreview(null); setOpen(false); }, title: '收起' }, '收起'),
          ),
          h(
            'div',
            { className: 'dzw-body' },
            // 登录失效：一行中性提示 + 下面的登录表单，用户填一次就能继续 —— 不做成红色报错、也不留死界面。
            authExpired && !error ? h('div', { className: 'dzw-msg info' }, '禅道登录状态已失效（Token 过期或被踢），请重新登录后继续。') : null,
            error ? h('div', { className: 'dzw-msg err' }, error) : null,
            toast ? h('div', { className: 'dzw-msg info' }, toast) : null,

            loggedIn && !authExpired
              ? null
              : h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'dzw-row' },
                    h('label', null, '服务器'),
                    h('input', {
                      className: 'dzw-input',
                      value: form.server,
                      placeholder: 'http://www.example.com:11180/zentao',
                      onChange: (event) => setForm((prev) => ({ ...prev, server: event.target.value })),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'dzw-row' },
                    h('label', null, '账号'),
                    h('input', {
                      className: 'dzw-input',
                      value: form.account,
                      onChange: (event) => setForm((prev) => ({ ...prev, account: event.target.value })),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'dzw-row' },
                    h('label', null, '密码'),
                    h('input', {
                      className: 'dzw-input',
                      type: 'password',
                      value: form.password,
                      placeholder: '与 Token 二选一',
                      onChange: (event) => setForm((prev) => ({ ...prev, password: event.target.value })),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'dzw-row' },
                    h('label', null, 'Token'),
                    h('input', {
                      className: 'dzw-input',
                      value: form.token,
                      placeholder: '已有 Token 可直接填',
                      onChange: (event) => setForm((prev) => ({ ...prev, token: event.target.value })),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'dzw-row' },
                    h('label', null, ''),
                    h(
                      'label',
                      { className: 'dzw-check' },
                      h('input', {
                        type: 'checkbox',
                        checked: form.rememberPassword,
                        onChange: (event) => setForm((prev) => ({ ...prev, rememberPassword: event.target.checked })),
                      }),
                      '记住密码（加密后写入本机配置，Token 过期自动重新登录）',
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dzw-row' },
                    h('label', null, ''),
                    h(
                      'label',
                      { className: 'dzw-check' },
                      h('input', {
                        type: 'checkbox',
                        checked: form.rememberToken,
                        onChange: (event) => setForm((prev) => ({ ...prev, rememberToken: event.target.checked })),
                      }),
                      '记住 Token（写入 ~/.dsh-zentao-workbench.json，仅本机）',
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dzw-row' },
                    h('label', null, ''),
                    h('button', { className: 'dzw-btn primary', onClick: () => void doLogin(), disabled: busy }, busy ? '登录中…' : '登录'),
                  ),
                ),

            loggedIn && !authExpired
              ? h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'dzw-target', title: '点「处理」会在选中的工作区里新建会话并自动发送提示词' },
                    h(
                      'span',
                      { className: 'dzw-target-text' },
                      chosen === undefined
                        ? '发送目标：未找到工作区，请先在左侧打开一个项目'
                        : `发送目标：${chosenLabel}${pickSuffix}`,
                    ),
                    // 工作区只有一个时不必给下拉（省版面）；有多个才让人选（用户 m03741）。
                    targets.length > 1
                      ? h(
                          'select',
                          {
                            className: 'dzw-select',
                            value: pick,
                            title: '选择发送目标工作区',
                            onChange: (event) => setPick(event.target.value),
                          },
                          h('option', { value: '' }, targetLabel === '' ? '跟随当前工作区' : `跟随当前工作区（${targetLabel}）`),
                          ...targets.map((item) =>
                            h('option', { key: item.workspaceId, value: item.workspaceId }, describeWorkspace(item)),
                          ),
                        )
                      : null,
                  ),
                  // 已保存密码时给个明示 + 一键清除（密码是加密存的，但用户应当随时能撤掉）。
                  config !== null && config.rememberPassword === true
                    ? h(
                        'div',
                        { className: 'dzw-target', title: '密码以系统加密方式保存在本机配置文件里（换机器/换用户解不开）' },
                        h('span', { className: 'dzw-target-text' }, '已保存密码：Token 过期会自动重新登录'),
                        h(
                          'button',
                          { className: 'dzw-btn ghost', onClick: () => void doForgetPassword(), disabled: busy },
                          '清除已保存的密码',
                        ),
                      )
                    : null,
                  h('div', { className: 'dzw-tabs' }, tabButton('task'), tabButton('bug'), tabButton('story')),
                  // 渐进扫描进度：扫到第几个产品了（不阻塞列表，边扫边显示）。
                  progress !== null
                    ? h('div', { className: 'dzw-progress' }, `正在扫描 ${progress.done}/${progress.total} 个产品…（已扫到的先显示）`)
                    : null,
                  tab === 'task' && (data.taskTotal ?? 0) > (data.tasks ?? []).length
                    ? h('div', { className: 'dzw-empty' }, `共 ${data.taskTotal} 条任务，仅显示前 ${(data.tasks ?? []).length} 条`)
                    : null,
                  tab !== 'task' && data.scan !== null && data.scan.scannedProducts < data.scan.totalProducts
                    ? h('div', { className: 'dzw-empty' }, `已扫描前 ${data.scan.scannedProducts} / ${data.scan.totalProducts} 个产品`)
                    : null,
                  list.length === 0
                    ? h('div', { className: 'dzw-empty' }, busy ? '加载中…' : data.fetchedAt === '' ? '等待加载…' : '（暂无条目）')
                    : h('div', { className: 'dzw-list' }, list.map(itemNode)),
                )
              : null,
          ),
          h(
            'div',
            { className: 'dzw-foot' },
            h('span', null, config !== null && config.server ? config.server : '未配置服务器'),
            // 显示数据新鲜度：Bug/需求聚合有 2 分钟缓存，用户需要知道手里这份是什么时候的。
            data.fetchedAt === ''
              ? null
              : h('span', { className: 'dzw-fresh', title: `最近一次取数：${data.fetchedAt}` }, `更新于 ${String(data.fetchedAt).slice(11, 19)}`),
            loggedIn ? h('button', { className: 'dzw-btn ghost', style: { marginLeft: 'auto' }, onClick: () => void doLogout(), disabled: busy }, '退出登录') : null,
          ),
        ),
        h(
          'button',
          { className: 'dzw-launcher', onClick: () => setOpen(false), title: '收起禅道工作台', style: { opacity: 0.001, width: 1, height: 1, right: 8, bottom: 8 } },
          '',
        ),
        detailModal(),
        previewOverlay(),
        finishCard(),
        assignCard(),
      );
    }

    /** 给浮层用：当前工作区探测器 + 工作区清单 + 快照订阅器。 */
    function makeWorkspaceProbe(ctx) {
      const describe = () => resolveWorkspace(ctx.sessions, ctx.workspaces);
      const list = () => listWorkspaces(ctx.workspaces);
      const watch = (onChange) => {
        const stores = [];
        for (const store of [ctx.sessions === undefined ? undefined : ctx.sessions.list, ctx.workspaces === undefined ? undefined : ctx.workspaces.list]) {
          if (store !== undefined && typeof store.subscribe === 'function') stores.push(store);
        }
        const unsubscribes = stores.map((store) => store.subscribe(onChange));
        return () => {
          for (const unsubscribe of unsubscribes) unsubscribe();
        };
      };
      return { describe, list, watch };
    }

    /**
     * 激活浏览器半侧：注入样式 + 把工作台挂到 `shell.overlay` 插槽。
     * @param {any} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      const handlePrompt = makeHandlePrompt(ctx);
      const probe = makeWorkspaceProbe(ctx);
      // 一行启动自检：uiWorkspace 拿不到时会退化为 sessions.create，会话可见性会差一些。
      const uiWorkspace = peekService(ctx, 'uiWorkspace');
      console.info(`[zentao-workbench] uiWorkspace=${uiWorkspace === undefined ? 'unavailable' : 'ready'}`);

      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.pluginCss = 'dsh-zentao-workbench';
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => {
          style.remove();
        };
      }, 'dsh-zentao-workbench: styles');

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: SLOT_ID, order: 20 }, (slotProps) =>
          h(Workbench, { ...slotProps, handlePrompt, describeTarget: probe.describe, listTargets: probe.list, watchTarget: probe.watch }),
        ),
      );
    }

    module.exports = { name, inject, apply };
    return module.exports;
  },
});
