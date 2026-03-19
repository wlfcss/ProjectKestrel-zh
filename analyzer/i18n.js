(function () {
  const locale = "zh-CN";

  const messages = {
    "status.version_error": "版本：错误",
    "status.version_unknown": "版本：未知",
    "status.version_label": "版本：{version}",
    "status.pipeline_version_label": "流水线版本：{version}",
    "update.available_title": "发现新版本：{name}",
    "update.windows_note":
      'Windows 用户：如果你通过微软商店安装，请在 1-3 天内到商店检查更新。如果你使用的是传统安装包，请访问 <a href="https://projectkestrel.org/download" target="_blank" style="color:#7ca3d9;text-decoration:underline;">projectkestrel.org/download</a> 手动更新。',
    "update.download_macos": "前往 macOS 下载页",
    "update.download_windows": "前往 Windows 下载页",
    "queue.section_analyzing": "⚙ 分析中",
    "queue.section_pending": "⏳ 队列中（{count}）",
    "queue.section_add": "➕ 即将加入（{count}）",
    "queue.starting": "启动中…",
    "queue.pending": "等待中",
    "queue.remove_from_queue": "从队列移除",
    "queue.remove_from_selection": "从选择中移除",
    "queue.reanalyze": "将重新分析",
    "queue.desktop_only":
      "分析队列仅在桌面版（pywebview 模式）中可用。\n\n请以桌面应用方式运行 Project Kestrel 以使用该功能。",
    "queue.badge_paused": "已暂停",
    "queue.badge_done": "已完成",
    "queue.badge_pending": "{count} 个等待中",
    "queue.pause": "⏸ 暂停",
    "queue.resume": "▶ 继续",
    "queue.calculating_eta": "⏳ 正在计算剩余时间…",
    "queue.loading_analyzer": "⏳ {message}",
    "queue.loading_analyzer_fallback": "加载分析器中，请稍候…",
    "queue.overall_eta": "⏱ 预计总剩余时间：{time}",
    "queue.status_pending": "⏳ 队列中",
    "queue.status_running": "⚙ 分析中",
    "queue.status_done": "✓ 已完成",
    "queue.status_already_done": "✓ 已分析过",
    "queue.status_error": "✗ 错误",
    "queue.status_cancelled": "— 已取消",
    "queue.eta_paused": "{processed} / {total} — ⏸ 已暂停",
    "queue.eta_calculating": "{processed} / {total} — ⏳ 正在计算剩余时间…",
    "queue.eta_remaining": "{processed} / {total} — 预计还需 {time}",
    "queue.select_tree_folder": "请从下方目录树中选择一个文件夹来加载场景",
    "queue.restore_count": "{count} 个文件夹已选中",
    "folder.loaded_from": "已加载：{path}",
    "folder.no_database_in_tree": "该文件夹中没有 Kestrel 数据库，请选择目录树中带 📂 标记的文件夹",
    "folder.opening_picker": "正在打开文件夹选择器…",
    "folder.selection_cancelled": "已取消选择文件夹",
    "folder.picker_failed": "桌面版文件夹选择器失败：{message}\n\n请重启应用后重试。",
    "folder.picker_failed_status": "文件夹选择器失败",
    "folder.csv_loaded_limited": "CSV 已加载（功能受限：无法访问文件夹）",
    "folder.csv_loaded_limited_alert":
      "CSV 已成功加载。\n\n注意：在没有文件夹访问权限的情况下，图像预览和在编辑器中打开文件都无法使用。\n\n如需完整功能，请使用桌面版应用或基于 Chromium 的浏览器（Chrome、Edge、Brave）。",
    "folder.csv_load_failed": "CSV 加载失败",
    "folder.file_picker_limited": "正在打开文件选择器（功能受限）…",
    "folder.unexpected_error": "发生了意外错误",
    "folder.load_failed": "数据库加载失败",
    "folder.database_missing_alert":
      "无法从此文件夹加载 Kestrel 数据库。\n\n请确认：\n1. 该文件夹已经用 Kestrel 分析过\n2. `.kestrel` 文件夹存在（在 macOS 上它可能是隐藏的）\n3. 你选择的是正确的文件夹\n\n提示：在 macOS 上，`.kestrel` 默认隐藏。你可以：\n• 按 `Cmd+Shift+.` 显示 Finder 中的隐藏文件\n• 或直接选择包含 `.kestrel` 的上级文件夹\n\n错误：{error}",
    "folder.analysis_missing_alert":
      "找不到 Kestrel 分析文件。请确认该文件夹已经通过 Kestrel Analyzer 完成分析。",
    "merge.cross_folder_alert": "无法合并来自不同文件夹的场景。\n请选择同一文件夹中的场景。",
    "settings.browse_desktop_only": "“浏览”仅在桌面版应用中可用",
    "feedback.required": "⚠ 请输入描述。",
    "feedback.sending": "发送中…",
    "feedback.sent": "✓ 反馈已发送，感谢你的反馈！",
    "feedback.failed": "⚠ 发送失败，请稍后再试。",
    "feedback.failed_with_reason": "⚠ 发送失败：{message}",
    "analysis.clear_success": "已清除此文件夹的 Kestrel 分析数据：{folder}",
    "analysis.clear_failed": "清除分析数据失败：\n\n{error}",
    "analysis.clear_confirm":
      "确定要清除此文件夹的 Kestrel 分析数据吗？\n\n文件夹：{folder}\n\n这会删除 `.kestrel` 目录中的数据库、导出图和裁切图，但不会删除原始照片。",
    "status.showing": "当前显示 {scenes} 个场景，共 {images} 张图片{filtered}{dirty}",
    "status.filtered_suffix": "（从 {all} 个场景中过滤）",
    "status.unsaved": " • 有未保存更改",
    "status.scene_selected": "已选 {count} 个场景",
    "status.unknown_time": "未知时间",
    "status.no_folders_selected": "未选择任何文件夹，请在目录树中勾选文件夹以加载场景",
    "status.auto_refreshed": "已自动刷新 {count} 个新分析完成的文件夹",
    "status.building_scenes": "正在从 {count} 个文件夹构建场景…",
    "folder.group_unknown": "（未知文件夹）",
    "folder.action_open": "<i>📂</i> 打开",
    "folder.action_open_title": "在系统文件管理器中打开此文件夹",
    "folder.action_reset": "<i>↺</i> 重置筛选决定",
    "folder.action_reset_title": "重置此文件夹的接受/拒绝筛片决定",
    "folder.action_write_metadata": "<i>📝</i> 写入照片元数据",
    "folder.action_write_metadata_title": "为照片写入 XMP 旁车文件，包含星级评分、接受/拒绝决定和物种标签，可被 Lightroom、Capture One、darktable 等编辑器读取。",
    "folder.action_open_culling": "<i>✂</i> 打开筛片助手",
    "folder.action_open_culling_title": "为此文件夹打开 AI 辅助筛片工作区",
    "folder.options_title": "文件夹选项",
    "folder.options_reset_section": "重置筛片决定",
    "folder.options_reset_verified_title": "重置已确认决定",
    "folder.options_reset_verified_desc": "仅清除此文件夹中通过筛片助手最终确认的接受/拒绝决定。手动指定的决定会被保留。",
    "folder.options_reset_all_title": "重置全部决定",
    "folder.options_reset_all_desc": "清除此文件夹中所有手动和已确认的接受/拒绝决定，使全部图片回到“未决定”状态。自动分类结果不会受影响。",
    "common.close": "关闭",
    "rating.click_to_set": "点击设置评分",
    "tree.analysis_in_progress_suffix": "（分析进行中）",
    "merge.summary": "将 {count} 个场景合并到场景 {target}（共 {images} 张图片）。",
    "merge.scene_label": "场景 {id}",
    "merge.images_count": "{count} 张图片",
    "merge.merged_status": "已将场景合并到 {target}，共更新 {changed} 行。",
    "analysis.outdated_confirm":
      "以下文件夹由旧版本 Kestrel 分析：\n\n{names}\n\n当前版本：v{version}\n\n重新分析前会先删除现有分析数据（`.kestrel` 文件夹）。\n\n是否继续？",
    "analysis.queue_started": "分析队列已启动，已加入 {count} 个文件夹",
    "analysis.queue_start_failed": "启动分析队列失败：\n\n{error}",
    "analysis.desktop_browse_only": "目录浏览仅在桌面版应用中可用。",
    "analysis.legal_accepted": "已接受条款，欢迎使用 Project Kestrel！",
    "analysis.cancel_queue_confirm": "确定要取消分析队列吗？待处理文件夹将不会继续分析。",
  };

  function format(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, (_, key) =>
      vars && key in vars ? String(vars[key]) : `{${key}}`
    );
  }

  function t(key, vars) {
    const template = Object.prototype.hasOwnProperty.call(messages, key)
      ? messages[key]
      : key;
    return format(template, vars);
  }

  window.KestrelI18n = {
    locale,
    t,
  };
})();
