export interface Region {
  code: string
  name: string
  flag: string
  /** 匹配中文/全称 */
  re: RegExp
}

// 拉丁字母代码要求前后不是字母，避免 "RUSSIA" 命中 "US"
const L = (codes: string) => `(?:^|[^A-Za-z])(?:${codes})(?:[^A-Za-z]|$)`

export const REGIONS: Region[] = [
  { code: 'HK', name: '香港', flag: '🇭🇰', re: new RegExp(`港|Hong\\s*Kong|🇭🇰|${L('HK|HKG')}`, 'i') },
  { code: 'TW', name: '台湾', flag: '🇹🇼', re: new RegExp(`台|新北|彰化|Taiwan|🇹🇼|${L('TW|TWN')}`, 'i') },
  { code: 'JP', name: '日本', flag: '🇯🇵', re: new RegExp(`日本|东京|大阪|埼玉|Japan|Tokyo|Osaka|🇯🇵|${L('JP|JPN')}`, 'i') },
  { code: 'SG', name: '新加坡', flag: '🇸🇬', re: new RegExp(`新加坡|狮城|Singapore|🇸🇬|${L('SG|SGP')}`, 'i') },
  {
    code: 'US',
    name: '美国',
    flag: '🇺🇸',
    re: new RegExp(`美国|洛杉矶|圣何塞|硅谷|西雅图|芝加哥|纽约|达拉斯|凤凰城|United\\s*States|America|Los\\s*Angeles|San\\s*Jose|Seattle|🇺🇸|${L('US|USA')}`, 'i'),
  },
  { code: 'KR', name: '韩国', flag: '🇰🇷', re: new RegExp(`韩国|韓|首尔|春川|Korea|Seoul|🇰🇷|${L('KR|KOR')}`, 'i') },
  { code: 'GB', name: '英国', flag: '🇬🇧', re: new RegExp(`英国|伦敦|United\\s*Kingdom|Britain|London|🇬🇧|${L('UK|GB|GBR')}`, 'i') },
  { code: 'DE', name: '德国', flag: '🇩🇪', re: new RegExp(`德国|法兰克福|Germany|Frankfurt|🇩🇪|${L('DE|DEU')}`, 'i') },
  { code: 'FR', name: '法国', flag: '🇫🇷', re: new RegExp(`法国|巴黎|France|Paris|🇫🇷|${L('FR|FRA')}`, 'i') },
  { code: 'NL', name: '荷兰', flag: '🇳🇱', re: new RegExp(`荷兰|阿姆斯特丹|Netherlands|Amsterdam|🇳🇱|${L('NL|NLD')}`, 'i') },
  { code: 'CA', name: '加拿大', flag: '🇨🇦', re: new RegExp(`加拿大|多伦多|温哥华|Canada|Toronto|🇨🇦|${L('CA|CAN')}`, 'i') },
  { code: 'AU', name: '澳大利亚', flag: '🇦🇺', re: new RegExp(`澳大利亚|澳洲|悉尼|Australia|Sydney|🇦🇺|${L('AU|AUS')}`, 'i') },
  { code: 'RU', name: '俄罗斯', flag: '🇷🇺', re: new RegExp(`俄罗斯|莫斯科|Russia|Moscow|🇷🇺|${L('RU|RUS')}`, 'i') },
  { code: 'IN', name: '印度', flag: '🇮🇳', re: new RegExp(`印度|孟买|India|Mumbai|🇮🇳|${L('IN|IND')}`, 'i') },
  { code: 'TR', name: '土耳其', flag: '🇹🇷', re: new RegExp(`土耳其|伊斯坦布尔|Turkey|Türkiye|Istanbul|🇹🇷|${L('TR|TUR')}`, 'i') },
  { code: 'MY', name: '马来西亚', flag: '🇲🇾', re: new RegExp(`马来|吉隆坡|Malaysia|🇲🇾|${L('MY|MYS')}`, 'i') },
  { code: 'TH', name: '泰国', flag: '🇹🇭', re: new RegExp(`泰国|曼谷|Thailand|🇹🇭|${L('TH|THA')}`, 'i') },
  { code: 'VN', name: '越南', flag: '🇻🇳', re: new RegExp(`越南|Vietnam|🇻🇳|${L('VN|VNM')}`, 'i') },
  { code: 'PH', name: '菲律宾', flag: '🇵🇭', re: new RegExp(`菲律宾|Philippines|🇵🇭|${L('PH|PHL')}`, 'i') },
  { code: 'AR', name: '阿根廷', flag: '🇦🇷', re: new RegExp(`阿根廷|Argentina|🇦🇷|${L('AR|ARG')}`, 'i') },
  { code: 'BR', name: '巴西', flag: '🇧🇷', re: new RegExp(`巴西|Brazil|🇧🇷|${L('BR|BRA')}`, 'i') },
]

/** 输出时默认生成分组的地区 */
export const GROUP_REGIONS = ['HK', 'TW', 'JP', 'SG', 'US', 'KR']

export function detectRegion(name: string): Region | undefined {
  return REGIONS.find((r) => r.re.test(name))
}

/** 两位国家代码 → 国旗 emoji */
export function flagEmoji(code: string): string {
  return /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : ''
}
