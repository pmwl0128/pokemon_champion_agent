"""Human-facing text for the pcui CLI. Wire JSON and command names remain invariant."""
from __future__ import annotations

import os

LANGS = ("zh", "ja", "en")
_lang = "en"


def set_lang(value: str | None = None) -> str:
    global _lang
    candidate = (value or os.environ.get("POKEMON_CHAMPIONS_LANG") or "en").lower()
    _lang = candidate if candidate in LANGS else "en"
    return _lang


def t(key: str, **values: object) -> str:
    row = TEXT.get(key, {})
    text = row.get(_lang) or row.get("en") or key
    return text.format(**values) if values else text


_ARGPARSE = {
    "zh": {
        "usage: ": "用法：",
        "positional arguments": "位置参数",
        "options": "选项",
        "show this help message and exit": "显示此帮助信息并退出",
        "the following arguments are required: %s": "缺少必需参数：%s",
        "unrecognized arguments: %s": "无法识别的参数：%s",
        "argument %s: expected one argument": "参数 %s 需要一个值",
        "argument %s: invalid choice: %(value)r (choose from %(choices)s)":
            "参数 %s：%(value)r 不是有效选项（可选：%(choices)s）",
    },
    "ja": {
        "usage: ": "使用方法：",
        "positional arguments": "位置引数",
        "options": "オプション",
        "show this help message and exit": "このヘルプを表示して終了",
        "the following arguments are required: %s": "次の引数が必要です：%s",
        "unrecognized arguments: %s": "認識できない引数：%s",
        "argument %s: expected one argument": "引数 %s には値が必要です",
        "argument %s: invalid choice: %(value)r (choose from %(choices)s)":
            "引数 %s：%(value)r は選べません（選択肢：%(choices)s）",
    },
}


def argparse_text(text: str) -> str:
    """Translate argparse's fixed UI while leaving flags and choices untouched."""
    return _ARGPARSE.get(_lang, {}).get(text, text)


TEXT = {
    "description": {"zh": "Pokémon Champions 可视化界面与本地桥接命令行工具。", "ja": "Pokémon Champions の画面とローカルブリッジ用CLI。", "en": "Pokémon Champions UI and local bridge CLI."},
    "lang_help": {"zh": "显示文本的语言；JSON 与命令名保持不变", "ja": "表示テキストの言語。JSONとコマンド名は変わりません", "en": "language for display text; JSON and command names stay unchanged"},
    "serve_help": {"zh": "启动本地桥接服务", "ja": "ローカルブリッジを起動", "en": "run the local bridge"},
    "online_help": {"zh": "启动公开在线 API", "ja": "公開オンラインAPIを起動", "en": "run the public online API"},
    "doctor_help": {"zh": "检查运行环境", "ja": "実行環境を確認", "en": "check the environment"},
    "session_help": {"zh": "管理会话", "ja": "セッションを管理", "en": "manage sessions"},
    "artifact_help": {"zh": "管理会话产物", "ja": "セッション成果物を管理", "en": "manage session artifacts"},
    "run_help": {"zh": "在已启动的服务中运行一个允许的队伍算子", "ja": "起動中のサービスで許可済み構築処理を1つ実行", "en": "run one whitelisted team operator in the daemon"},
    "dist_help": {"zh": "挂载到根路径的已构建网页", "ja": "ルートに配信するビルド済みWeb画面", "en": "built SPA to host at /"},
    "projection_help": {"zh": "挂载到 /projection 的静态数据投影", "ja": "/projection に配信する静的データ", "en": "static projection to host at /projection"},
    "provider_help": {"zh": "openai-compatible 使用统一 LLM 配置；deepseek 是兼容别名；none 禁用模型；echo 仅供开发", "ja": "openai-compatible は統一 LLM 設定を使用、deepseek は互換エイリアス、none はモデル無効、echo は開発専用", "en": "openai-compatible uses the unified LLM config; deepseek is a compatibility alias; none disables the model; echo is development-only"},
    "env_file_help": {"zh": "持久环境变量文件（KEY=value；已设置的进程变量优先）", "ja": "永続環境変数ファイル（KEY=value。設定済みのプロセス変数を優先）", "en": "persistent environment file (KEY=value; existing process variables take precedence)"},
    "qa_limit_help": {"zh": "每个匿名身份每日（UTC）可提问次数", "ja": "匿名IDごとのUTC日次質問上限", "en": "questions per anonymous identity per UTC day"},
    "qa_budget_help": {"zh": "每日模型 token 总预算", "ja": "モデルのUTC日次トークン予算", "en": "total model tokens per UTC day"},
    "idle_help": {"zh": "查询进程空闲多少秒后回收；0 表示不回收", "ja": "照会ワーカーを回収するまでのアイドル秒数。0は回収なし", "en": "idle seconds before query workers are reclaimed; 0 means never"},
    "op_help": {"zh": "队伍算子名称（服务端执行允许列表）", "ja": "構築処理名（サーバー側の許可リストを適用）", "en": "team operator name (the daemon enforces its allowlist)"},
    "args_help": {"zh": "JSON 对象形式的额外算子字段", "ja": "JSONオブジェクト形式の追加フィールド", "en": "extra operator fields as a JSON object"},
    "file_help": {"zh": "读入 JSON 文件并写入算子的 {field} 字段", "ja": "JSONファイルを読み込み、処理の {field} フィールドへ設定", "en": "inline a JSON file into the operator's {field} field"},
    "dir_help": {"zh": "明确指定技能目录（优先于 --target）", "ja": "スキルディレクトリを直接指定（--targetより優先）", "en": "explicit skills directory (overrides --target)"},
    "yes_help": {"zh": "跳过确认", "ja": "確認を省略", "en": "skip confirmation"},
    "install_help": {"zh": "安装 AI 助手配套技能", "ja": "AIアシスタント用コンパニオンスキルをインストール", "en": "install the companion skill for an AI assistant"},
    "uninstall_help": {"zh": "卸载 AI 助手配套技能", "ja": "AIアシスタント用コンパニオンスキルを削除", "en": "uninstall the companion skill for an AI assistant"},
    "companion_dest": {"zh": "配套技能 → {dest}", "ja": "コンパニオンスキル → {dest}", "en": "companion skill → {dest}"},
    "expose_local": {"zh": "警告：绑定 {host} 会使本地桥接服务可被本机以外的设备访问。", "ja": "警告：{host} にバインドすると、ローカルブリッジが他の端末からもアクセス可能になります。", "en": "WARNING: binding {host} exposes the bridge beyond this machine."},
    "expose_online": {"zh": "警告：绑定 {host} 会使在线 API 可被本机以外的设备访问。", "ja": "警告：{host} にバインドすると、オンラインAPIが他の端末からもアクセス可能になります。", "en": "WARNING: binding {host} exposes the online API beyond this machine."},
    "confirm": {"zh": "输入 yes 继续：", "ja": "続行するには yes と入力：", "en": "type 'yes' to continue: "},
    "daemon_running": {"zh": "pcui 服务已在运行（PID {pid}，端口 {port}）；请先停止它。", "ja": "pcuiサービスはすでに実行中です（PID {pid}、ポート {port}）。先に停止してください。", "en": "a pcui daemon is already running (pid {pid}, port {port}); stop it first."},
    "daemon_unreachable": {"zh": "daemon.json 记录的进程 {pid} 仍在运行（端口 {port}），但服务无响应。为避免并发写入，已拒绝直接写 SQLite；请停止服务或修复连接。", "ja": "daemon.json上のプロセス {pid}（ポート {port}）は生存していますが応答しません。二重書き込みを避けるためSQLiteへの直接書き込みを拒否しました。サービスを停止するか接続を修復してください。", "en": "daemon.json says pid {pid} is alive on port {port} but is not answering; direct SQLite writes were refused to prevent split-brain. Stop the daemon or fix connectivity."},
    "llm_key_missing": {"zh": "警告：未设置 PCUI_LLM_API_KEY（或兼容的 DEEPSEEK_API_KEY）；设置前模型接口将返回 503（llm_unavailable）。", "ja": "警告：PCUI_LLM_API_KEY（または互換の DEEPSEEK_API_KEY）が未設定です。設定するまでモデルAPIは503（llm_unavailable）を返します。", "en": "WARNING: PCUI_LLM_API_KEY (or legacy DEEPSEEK_API_KEY) is not set; LLM endpoints return 503 until configured."},
    "unlimited_refused": {"zh": "拒绝启用本地无限额模式：该模式只允许回环地址且必须未设置 PCUI_PUBLIC_ORIGIN。", "ja": "ローカル無制限モードを拒否しました。このモードはループバックで PCUI_PUBLIC_ORIGIN 未設定の場合のみ使用できます。", "en": "refusing local unmetered mode: it requires a loopback bind and no PCUI_PUBLIC_ORIGIN"},
    "env_file_invalid": {"zh": "环境变量文件格式错误：{path} 第 {line} 行", "ja": "環境変数ファイルの形式が不正です：{path} の {line} 行目", "en": "invalid environment file syntax: {path}, line {line}"},
    "secret_missing": {"zh": "警告：未设置 PCUI_ONLINE_SECRET，将使用仅本次进程有效的密钥；设备 cookie 和 IP 哈希会在重启后失效，仅适合开发环境。", "ja": "警告：PCUI_ONLINE_SECRET が未設定のため、プロセス限りの鍵を使用します。再起動すると端末CookieとIPハッシュが変わります。開発用途に限ってください。", "en": "WARNING: PCUI_ONLINE_SECRET is not set; using a per-process secret. Device cookies and IP hashes reset on restart, so this is for development only."},
    "doctor_ok": {"zh": "环境检查：全部正常。", "ja": "環境チェック：問題ありません。", "en": "doctor: all good."},
    "doctor_fail": {"zh": "环境检查：发现问题。", "ja": "環境チェック：問題が見つかりました。", "en": "doctor: problems found."},
    "status_ok": {"zh": "正常", "ja": "正常", "en": "ok"},
    "status_fail": {"zh": "异常", "ja": "エラー", "en": "FAIL"},
    "check_skill": {"zh": "技能命令：{name}", "ja": "スキルCLI：{name}", "en": "skill CLI: {name}"},
    "check_mirror": {"zh": "技能镜像目录", "ja": "スキルのミラーディレクトリ", "en": "mirror tree present"},
    "check_quickjs": {"zh": "quickjs-ng 运行时", "ja": "quickjs-ngランタイム", "en": "quickjs-ng runtime"},
    "check_node": {"zh": "Node.js 回退", "ja": "Node.jsフォールバック", "en": "Node.js fallback"},
    "check_meta": {"zh": "当前环境索引", "ja": "現在の環境インデックス", "en": "meta current.json"},
    "check_write": {"zh": "数据目录可写", "ja": "データディレクトリへ書き込み可能", "en": "data directory writable"},
    "check_daemon": {"zh": "本地服务", "ja": "ローカルサービス", "en": "daemon"},
    "check_probe": {"zh": "图鉴端到端测试", "ja": "図鑑のエンドツーエンドテスト", "en": "dex end-to-end probe"},
    "running": {"zh": "运行于端口 {port}", "ja": "ポート{port}で実行中", "en": "running on port {port}"},
    "not_running": {"zh": "未运行", "ja": "停止中", "en": "not running"},
    "calc_runtime": {"zh": "进程内计算引擎", "ja": "プロセス内計算エンジン", "en": "in-process calculator engine"},
    "calc_missing": {"zh": "未找到 quickjs-ng 或 Node.js，计算器无法运行", "ja": "quickjs-ngもNode.jsも見つからないため、計算機を実行できません", "en": "neither quickjs-ng nor Node.js was found; the calculator will fail"},
    "need_id": {"zh": "session show 需要 --id", "ja": "session show には --id が必要です", "en": "session show needs --id"},
    "no_artifact": {"zh": "会话中没有“{kind}”产物", "ja": "セッションに「{kind}」成果物がありません", "en": "session has no '{kind}' artifact"},
    "run_need_daemon": {"zh": "pcui run 需要已启动的服务（先运行 `pcui serve`）；算子会在常驻查询进程中执行。", "ja": "pcui run には起動中のサービスが必要です（先に `pcui serve` を実行）。処理は常駐ワーカー内で実行されます。", "en": "pcui run needs a running daemon (`pcui serve`); operators execute inside its resident workers."},
    "args_object": {"zh": "--args 必须是 JSON 对象", "ja": "--args はJSONオブジェクトで指定してください", "en": "--args must be a JSON object"},
    "write_confirm": {"zh": "输入 yes 写入：", "ja": "書き込むには yes と入力：", "en": "type 'yes' to write: "},
    "installed": {"zh": "已安装。触发语：“处理当前 Pokémon UI 会话”／“work on the current Pokémon UI session”。", "ja": "インストールしました。呼び出し文：「現在の Pokémon UI セッションを処理して」／「work on the current Pokémon UI session」。", "en": "Installed. Trigger phrase: \"work on the current Pokémon UI session\"."},
    "refuse_delete": {"zh": "{dest} 不是已安装的 {name} 技能，拒绝删除。", "ja": "{dest} はインストール済みの {name} スキルではないため、削除しません。", "en": "{dest} is not an installed {name} skill; refusing to delete."},
    "removed": {"zh": "已删除 {dest}", "ja": "{dest} を削除しました", "en": "removed {dest}"},
}
