import { useState } from 'react'
import { AlertDialog, Button, Card, Chip, Description, InputGroup, Label, TextField, Typography } from '@heroui/react'
import { Check, Fingerprint, FloppyDisk, Key, Lock, ShieldCheck } from '@gravity-ui/icons'
import { useAuthStore } from '../../../stores/authStore'

interface SecurityTabProps {
  isMac: boolean
  showMessage: (text: string, success: boolean) => void
}

interface SecurityConfirmState {
  show: boolean
  title: string
  message: string
  onConfirm: () => void | Promise<void>
}

function SecurityTab({ isMac, showMessage }: SecurityTabProps) {
  const { isAuthEnabled, enableAuth, disableAuth, setupPassword, authMethod } = useAuthStore()
  const [passwordInput, setPasswordInput] = useState('')
  const [showPasswordInput, setShowPasswordInput] = useState(false)
  const [securityConfirm, setSecurityConfirm] = useState<SecurityConfirmState>({
    show: false, title: '', message: '', onConfirm: () => { }
  })

  const biometricLabel = isMac ? 'Touch ID' : 'Windows Hello'
  const isBiometricActive = isAuthEnabled && authMethod === 'biometric'
  const isPasswordActive = isAuthEnabled && authMethod === 'password'
  const shouldShowPasswordSetup = showPasswordInput || isPasswordActive

  const closeConfirm = () => {
    setSecurityConfirm(prev => ({ ...prev, show: false }))
  }

  const activateBiometric = async () => {
    showMessage(`正在等待${biometricLabel}验证...`, true)
    const result = await enableAuth()
    if (result.success) {
      showMessage(`已启用${biometricLabel}`, true)
      setShowPasswordInput(false)
      setPasswordInput('')
    } else {
      showMessage(result.error || '启用失败', false)
    }
  }

  const savePassword = async () => {
    if (!passwordInput) return

    const result = await setupPassword(passwordInput)
    if (result.success) {
      showMessage(isPasswordActive ? '密码已更新' : '已启用密码锁', true)
      setPasswordInput('')
      setShowPasswordInput(false)
    } else {
      showMessage(result.error || '设置失败', false)
    }
  }

  const handleSecurityMethodSelect = async (method: 'biometric' | 'password') => {
    if (isAuthEnabled && authMethod === method) {
      await disableAuth()
      showMessage('已关闭应用锁', true)
      if (method === 'password') {
        setShowPasswordInput(false)
        setPasswordInput('')
      }
      return
    }

    if (isAuthEnabled && authMethod !== method) {
      setSecurityConfirm({
        show: true,
        title: '切换认证方式',
        message: method === 'biometric'
          ? `切换到${biometricLabel}将清除当前的密码设置，是否继续？`
          : '切换到密码认证将清除当前的生物识别设置，是否继续？',
        onConfirm: async () => {
          await disableAuth()
          if (method === 'biometric') {
            await activateBiometric()
          } else {
            setShowPasswordInput(true)
          }
          closeConfirm()
        }
      })
      return
    }

    if (method === 'biometric') {
      await activateBiometric()
    } else {
      setShowPasswordInput(true)
    }
  }

  return (
    <div className="tab-content space-y-6">
      <section className="space-y-2">
        <Typography.Heading level={3} className="text-lg font-semibold text-foreground">安全保护</Typography.Heading>
        <Typography.Paragraph size="sm" color="muted">
          {isMac ? '配置应用启动时的安全验证方式。macOS 优先使用 Touch ID，设备不支持时可改用自定义密码。' : '配置应用启动时的安全验证方式，保护您的隐私数据。'}
        </Typography.Paragraph>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="h-fit">
          <Card.Header className="flex-row items-start justify-between gap-3">
            <div className="flex min-w-0 gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-default text-foreground">
                <Fingerprint width={20} height={20} />
              </div>
              <div className="min-w-0">
                <Card.Title>{biometricLabel}</Card.Title>
                <Card.Description>
                  {isMac
                    ? '使用 macOS 系统 Touch ID 进行验证。设备未启用或不支持时，请改用自定义密码。'
                    : '使用系统的面部识别、指纹或 PIN 码进行验证。体验流畅，安全性高。'}
                </Card.Description>
              </div>
            </div>
            {isBiometricActive && (
              <Chip size="sm" variant="soft" color="success">
                <Check width={12} height={12} />
                <Chip.Label>已启用</Chip.Label>
              </Chip>
            )}
          </Card.Header>
          <Card.Content>
            <Description>
              {isBiometricActive ? '再次点击下方按钮可关闭应用锁。' : '启用后，打开应用时需要完成系统验证。'}
            </Description>
          </Card.Content>
          <Card.Footer>
            <Button
              type="button"
              variant={isBiometricActive ? 'outline' : 'primary'}
              onPress={() => void handleSecurityMethodSelect('biometric')}
            >
              <Lock width={16} height={16} />
              {isBiometricActive ? '关闭应用锁' : `启用${biometricLabel}`}
            </Button>
          </Card.Footer>
        </Card>

        <Card className="h-fit">
          <Card.Header className="flex-row items-start justify-between gap-3">
            <div className="flex min-w-0 gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-default text-foreground">
                <ShieldCheck width={20} height={20} />
              </div>
              <div className="min-w-0">
                <Card.Title>自定义应用密码</Card.Title>
                <Card.Description>
                  {isMac
                    ? '设置应用专属密码。当前 macOS 侧只提供这一种应用锁方式。'
                    : '设置应用专属密码。不方便使用生物识别时推荐。'}
                </Card.Description>
              </div>
            </div>
            {isPasswordActive && (
              <Chip size="sm" variant="soft" color="success">
                <Check width={12} height={12} />
                <Chip.Label>已启用</Chip.Label>
              </Chip>
            )}
          </Card.Header>

          <Card.Content className="space-y-4">
            <Description>
              {isPasswordActive ? '可修改当前密码，或关闭应用锁。' : '启用后，打开应用时需要输入此应用密码。'}
            </Description>

            {shouldShowPasswordSetup && (
              <TextField fullWidth value={passwordInput} onChange={setPasswordInput}>
                <Label>{isPasswordActive ? '修改密码（留空不修改）' : '设置新密码'}</Label>
                <InputGroup fullWidth variant="secondary">
                  <InputGroup.Prefix>
                    <Key width={16} height={16} />
                  </InputGroup.Prefix>
                  <InputGroup.Input type="password" placeholder="请输入应用密码" />
                </InputGroup>
              </TextField>
            )}
          </Card.Content>

          <Card.Footer className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={isPasswordActive ? 'outline' : 'primary'}
              onPress={() => void handleSecurityMethodSelect('password')}
            >
              <Lock width={16} height={16} />
              {isPasswordActive ? '关闭应用锁' : '启用密码锁'}
            </Button>
            {shouldShowPasswordSetup && (
              <Button
                type="button"
                variant="secondary"
                onPress={() => void savePassword()}
                isDisabled={!passwordInput}
              >
                <FloppyDisk width={16} height={16} /> 保存密码
              </Button>
            )}
          </Card.Footer>
        </Card>
      </section>

      {securityConfirm.show && (
        <AlertDialog isOpen={securityConfirm.show} onOpenChange={(open) => {
          if (!open) closeConfirm()
        }}>
          <Button className="hidden" aria-hidden="true">打开确认框</Button>
          <AlertDialog.Backdrop>
            <AlertDialog.Container>
              <AlertDialog.Dialog className="sm:max-w-105">
                <AlertDialog.CloseTrigger />
                <AlertDialog.Header>
                  <AlertDialog.Icon status="warning" />
                  <AlertDialog.Heading>{securityConfirm.title}</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p>{securityConfirm.message}</p>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button slot="close" variant="tertiary">取消</Button>
                  <Button
                    slot="close"
                    variant="primary"
                    onPress={() => void securityConfirm.onConfirm()}
                  >
                    确定
                  </Button>
                </AlertDialog.Footer>
              </AlertDialog.Dialog>
            </AlertDialog.Container>
          </AlertDialog.Backdrop>
        </AlertDialog>
      )}
    </div>
  )
}

export default SecurityTab
