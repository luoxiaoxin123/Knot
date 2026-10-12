import type { DbData, Profile, Settings } from '../../shared/types.ts'

export const URIS = [
  'vless://b831381d-6324-4d53-ad4f-8cda48b30811@1.2.3.4:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sid=6ba85179e30d4fc2&type=tcp#🇭🇰 HK Reality',
  'vless://b831381d-6324-4d53-ad4f-8cda48b30811@ws.example.com:443?encryption=none&security=tls&sni=ws.example.com&type=ws&host=ws.example.com&path=%2Fray%3Fed%3D2048#JP WS',
  'vless://b831381d-6324-4d53-ad4f-8cda48b30811@grpc.example.com:443?security=tls&type=grpc&serviceName=gsvc#US gRPC',
  'hysteria2://pass%40word@hy.example.com:443/?sni=hy.example.com&obfs=salamander&obfs-password=xyz&insecure=1#SG Hy2',
  'hy2://letmein@[2001:db8::1]:8443,20000-30000/?sni=a.com#v6 hop',
  'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@5.6.7.8:8388#Tokyo SS',
  'ss://2022-blake3-aes-128-gcm:MTIzNDU2Nzg5MGFiY2RlZg%3D%3D@9.9.9.9:443#SS2022',
  'ss://YWVzLTI1Ni1nY206cGFzc3dvcmRAMTAuMC4wLjE6ODM4OA==#legacy',
  'ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpwd2Q@obfs.example.com:80/?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dbing.com#obfs',
  'trojan://secret@tj.example.com:443?sni=tj.example.com&type=ws&path=%2Ftj#Korea Trojan',
  'tuic://8f2e1e2a-1c1a-4c6e-9b5e-2a1e1c1a4c6e:pwd@tuic.example.com:443?congestion_control=bbr&alpn=h3&sni=tuic.example.com&udp_relay_mode=native#TUIC',
  'anytls://pw@any.example.com:443/?sni=any.example.com&insecure=1#AnyTLS',
  'socks5://user:pass@10.0.0.2:1080#socks',
  'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: '台湾 VMess', add: 'vm.example.com', port: '443', id: '6d4c5b2a-1111-2222-3333-444455556666', aid: '0', scy: 'auto', net: 'ws', type: 'none', host: 'vm.example.com', path: '/vm', tls: 'tls', sni: 'vm.example.com' })).toString('base64'),
]

export const settings: Settings = {
  publicUrl: '',
  ruleMirror: 'github',
  ruleMirrorCustom: '',
  ruleDownloadViaProxy: true,
  testUrl: 'https://www.gstatic.com/generate_204',
  s3: { enabled: false, endpoint: '', region: 'auto', bucket: '', accessKeyId: '', secretAccessKey: '', prefix: 'switch/', pathStyle: false, intervalHours: 0, keep: 10 },
}

export function profile(p: Partial<Profile> = {}): Profile {
  return {
    id: 'p1', name: '测试', token: 't', nodeMode: 'all', sources: [], nodeIds: [], includeRegex: '', excludeRegex: '',
    ruleMode: 'modules', modules: ['private', 'ads', 'ai', 'telegram', 'youtube', 'google', 'github', 'twitter', 'netflix', 'microsoft', 'apple', 'gfw', 'cn', 'final'],
    useCustomRules: true, regionGroups: true, groupsIncludeNodes: true, addFlags: true, trafficInfo: false, overrideYaml: '', createdAt: 0, ...p,
  }
}
export type { DbData }
