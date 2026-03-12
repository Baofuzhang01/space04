import os 
from .encrypt import AES_Encrypt, AES_Decrypt, generate_captcha_key, enc, verify_param
from .reserve import reserve

def _fetch_env_variables(env_name, action):
    try:
        return os.environ[env_name] if action else ""
    except KeyError:
        print(f"Environment variable {env_name} is not configured correctly.")
        return None

def get_user_credentials(action):
    """在 GitHub Actions(--action) 模式下优先使用环境变量账号.

    优先级:
    1. CX_USERNAME / CX_PASSWORD (你之前一直在用的变量名)
    2. USERNAMES / PASSWORDS (兼容旧配置, 允许逗号分隔多账号)

    本地不带 --action 运行时, 仍然使用 config.json 里的 username/password.
    """
    if not action:
        # 本地模式直接用 config.json 里的用户名/密码
        return "", ""

    # 1. 优先使用 CX_USERNAME / CX_PASSWORD
    cx_username = os.environ.get("CX_USERNAME")
    cx_password = os.environ.get("CX_PASSWORD")
    if cx_username and cx_password:
        return cx_username, cx_password

    # 2. 兼容旧的 USERNAMES / PASSWORDS（支持逗号分隔多账号）
    usernames = _fetch_env_variables("USERNAMES", action)
    passwords = _fetch_env_variables("PASSWORDS", action)
    return usernames, passwords
