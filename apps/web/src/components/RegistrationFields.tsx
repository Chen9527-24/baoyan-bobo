/** Shared account identity fields: both registration paths use the same requirements. */
export function RegistrationFields({ childName, onChildName, phone, onPhone, pin, onPin, pinAgain, onPinAgain, disabled = false }: {
 childName: string; onChildName: (value: string) => void; phone: string; onPhone: (value: string) => void;
 pin: string; onPin: (value: string) => void; pinAgain: string; onPinAgain: (value: string) => void; disabled?: boolean;
}) {
 return <>
  <label className="field">小朋友姓名<input required value={childName} maxLength={12} autoComplete="off" disabled={disabled} onChange={event => onChildName(event.target.value)}/><small>宝妍会记住这个称呼。内测请填写虚构姓名。</small></label>
  <label className="field">联系手机号<input required type="tel" inputMode="tel" autoComplete="tel" value={phone} maxLength={40} disabled={disabled} onChange={event => onPhone(event.target.value)}/><small>仅用于运营联系，不做短信验证，也不用于登录或找回密码。</small></label>
  <div className="form-grid">
   <label className="field">设置账号 PIN<input required type="password" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} autoComplete="new-password" value={pin} disabled={disabled} onChange={event => onPin(event.target.value.replace(/\D/g, ''))}/></label>
   <label className="field">再次输入 PIN<input required type="password" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} autoComplete="new-password" value={pinAgain} disabled={disabled} onChange={event => onPinAgain(event.target.value.replace(/\D/g, ''))}/></label>
  </div><p className="helper">PIN为6位数字，跟随自己的账号，用于进入家长管理。</p>
 </>;
}

export function registrationIdentityError(childName: string, phone: string, pin: string, pinAgain: string) {
 if (!childName.trim() || Array.from(childName.trim()).length > 12 || /[\u0000-\u001f\u007f]/.test(childName)) return '请填写1–12字的小朋友姓名。';
 const normalizedPhone = phone.trim().replace(/[\s-]/g, '');
 if (!/^(?:1[3-9]\d{9}|\+[1-9]\d{6,14})$/.test(normalizedPhone)) return '请填写国内11位手机号，或以+和国家区号开头的国际号码。';
 if (!/^\d{6}$/.test(pin) || pin !== pinAgain) return '请设置6位数字账号PIN，并确认两次输入一致。';
 return '';
}
