import { useId } from 'react';
import { useAppearance } from '../hooks/useAppearance';
import { HeaderMenu } from './Common';
import { Icon } from './Icon';

export function AppearanceMenu() {
  const { scheme, oled, dark, setPreferences, available } = useAppearance();
  const group = useId();
  return <HeaderMenu label="外观设置" icon={<Icon name={dark ? 'moon' : 'sun'} size={17} />} className="appearance-menu">
    <div className="menu-heading">外观</div>
    <fieldset className="appearance-options" disabled={!available}><legend className="sr-only">配色模式</legend>
      {([{ value: 'auto', label: '跟随系统', icon: 'system' }, { value: 'light', label: '浅色', icon: 'sun' }, { value: 'dark', label: '深色', icon: 'moon' }] as const).map(option => <label key={option.value} className="menu-option"><Icon name={option.icon} size={17} /><span>{option.label}</span><input type="radio" name={group} value={option.value} checked={scheme === option.value} onChange={() => setPreferences({ scheme: option.value })} /></label>)}
    </fieldset>
    <div className="menu-divider" /><label className={`menu-option oled-option ${!dark ? 'muted' : ''}`}><span><strong>OLED 纯黑</strong><small>仅在深色外观下生效</small></span><input type="checkbox" checked={oled} disabled={!dark || !available} onChange={event => setPreferences({ oled: event.target.checked })} /></label>
    <p className="menu-note">仅影响工作台外壳，原 NF 外观独立设置。</p>
    {!available && <p className="menu-note" role="status">外观设置未加载，请刷新重试。</p>}
  </HeaderMenu>;
}
