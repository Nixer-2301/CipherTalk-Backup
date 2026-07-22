import { useState, useEffect, useRef, type CSSProperties } from 'react'
import { Avatar, Button } from '@heroui/react'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import { ChevronRight, CircleExclamation, Fingerprint, Lock } from '@gravity-ui/icons'
import './LockScreen.css'

const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties

export default function LockScreen() {
    const { userInfo } = useAppStore()
    const [password, setPassword] = useState('')
    const passwordInputRef = useRef<HTMLInputElement>(null)
    const { unlock, verifyPassword, authMethod } = useAuthStore()
    const [isVerifying, setIsVerifying] = useState(false)
    const [error, setError] = useState('')
    const [platformInfo, setPlatformInfo] = useState<{ platform: string; arch: string }>({ platform: 'win32', arch: 'x64' })
    const userDisplayName = userInfo?.nickName?.trim() || 'CipherTalk'
    const avatarFallback = userInfo?.nickName?.trim()?.slice(0, 1).toUpperCase()

    useEffect(() => {
        void window.electronAPI.app.getPlatformInfo().then(setPlatformInfo).catch(() => {
            // ignore
        })
    }, [])

    useEffect(() => {
        if (authMethod !== 'password') return
        const focusTimer = window.setTimeout(() => {
            passwordInputRef.current?.focus()
        }, 0)
        return () => window.clearTimeout(focusTimer)
    }, [authMethod])

    const handleUnlock = async () => {
        if (isVerifying) return
        setIsVerifying(true)
        setError('')

        try {
            const result = await unlock()
            if (!result.success) {
                // 如果是用户取消（比如刚启动时自动弹出被取消），可以不显示红色错误，或者显示比较温和的提示
                // 这里我们直接显示 store 中转换好的友好错误信息
                setError(result.error || '验证失败')
            }
        } catch (e: any) {
            // unlock 内部已经 catch 了所有错误并返回 friendly error，
            // 这里的 catch 理论上不会触发，除非 unlock 实现有变。
            // 依然做一个兜底
            console.error('LockScreen unlock error:', e)
            setError('验证过程发生意外错误')
        } finally {
            setIsVerifying(false)
        }
    }

    const handlePasswordUnlock = async (e?: React.FormEvent) => {
        e?.preventDefault()
        if (!password.trim() || isVerifying) return

        setIsVerifying(true)
        setError('')

        const result = await verifyPassword(password)
        if (!result.success) {
            setError(result.error || '密码错误')
            setIsVerifying(false)
        } else {
            // 成功，store 会自动更新状态，组件卸载
        }
    }

    return (
        <div className="lock-screen-overlay" style={noDragStyle}>
            <div className="lock-content" style={noDragStyle}>
                <div className="lock-avatar-container">
                    <Avatar className="lock-avatar" color="default" variant="soft">
                        {userInfo?.avatarUrl ? (
                            <Avatar.Image src={userInfo.avatarUrl} alt={userDisplayName} />
                        ) : null}
                        <Avatar.Fallback>
                            {avatarFallback || <Lock width={32} height={32} />}
                        </Avatar.Fallback>
                    </Avatar>
                    <div className="lock-icon">
                        <Lock width={14} height={14} />
                    </div>
                </div>

                <div className="lock-info">
                    <h2>CipherTalk 已锁定</h2>
                    <p>{userInfo?.nickName ? `欢迎回来，${userInfo.nickName}` : '需要验证身份以继续'}</p>
                </div>

                {authMethod === 'biometric' ? (
                    <Button
                        type="button"
                        className="unlock-btn"
                        variant="primary"
                        fullWidth
                        onPress={() => void handleUnlock()}
                        isPending={isVerifying}
                        isDisabled={isVerifying}
                    >
                        <Fingerprint width={20} height={20} />
                        {isVerifying ? '正在验证...' : platformInfo.platform === 'darwin' ? '使用 Touch ID 解锁' : '使用 Windows Hello 解锁'}
                    </Button>
                ) : (
                    <form className="password-form" onSubmit={handlePasswordUnlock} style={noDragStyle}>
                        <div
                            className="password-input-wrapper"
                            style={noDragStyle}
                            onMouseDown={(event) => {
                                if (event.target === event.currentTarget) {
                                    passwordInputRef.current?.focus()
                                }
                            }}
                        >
                            <input
                                ref={passwordInputRef}
                                type="password"
                                placeholder="请输入应用密码"
                                className="password-input"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoFocus
                                style={noDragStyle}
                            />
                            <button
                                type="submit"
                                className="password-submit-btn"
                                disabled={isVerifying || !password}
                                style={noDragStyle}
                            >
                                <ChevronRight width={20} height={20} />
                            </button>
                        </div>
                    </form>
                )}

                {error && (
                    <div className="error-message">
                        <CircleExclamation width={14} height={14} />
                        <span>{error}</span>
                    </div>
                )}
            </div>
        </div>
    )
}
