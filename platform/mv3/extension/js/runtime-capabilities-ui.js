/* uBlock Plus+ — implementation boundaries, English/Vietnamese. GPL-3.0-or-later. */
export function webRequestFirewallStatusText(capabilities, language = 'en') {
    const vi = language.toLowerCase().startsWith('vi');
    const state = capabilities.webRequestFirewall?.state;
    if ( capabilities.webRequestFirewallActive === true ) {
        return vi ? 'Đang hoạt động — bổ sung chặn firewall, DNR vẫn được áp dụng'
            : 'Active — supplementary firewall blocking; DNR remains in use';
    }
    if ( state === 'permission-required' ) {
        return vi ? 'Chưa có quyền — mở Chrome bằng launcher của bản thử nghiệm'
            : 'Permission required — open Chrome with the experimental launcher';
    }
    if ( state === 'starting' || state === 'suspended' ) {
        return vi ? 'Đang chuẩn bị hoặc cập nhật — chỉ áp dụng DNR'
            : 'Preparing or updating — DNR only';
    }
    if ( state === 'error' ) {
        const error = capabilities.webRequestFirewall?.error;
        const detail = typeof error === 'string' && error !== ''
            ? `: ${error.slice(0, 256)}` : '';
        return (vi ? 'Không sẵn sàng — chỉ áp dụng DNR'
            : 'Unavailable — DNR only') + detail;
    }
    return vi ? 'Có trong gói Experimental WebRequest riêng'
        : 'Available in the separate Experimental WebRequest package';
}

export function capabilityDetailsRows(capabilities, language = 'en') {
    const vi = language.toLowerCase().startsWith('vi');
    const text = vi ? {
        observation: 'Quan sát request mạng',
        observationAvailable: 'Có — chỉ thu thập sau khi bấm Bắt đầu trong Nhật ký',
        observationPermission: 'Chưa cấp quyền tùy chọn; có thể bật trong Nhật ký',
        unavailable: 'Không khả dụng với bản cài đặt hoặc trình duyệt này',
        matches: 'Sự kiện khớp quy tắc do Chrome cung cấp',
        matchesAvailable: 'Có — bản cài đặt dạng unpacked',
        matchesUnconfirmed: 'Có API và quyền; chưa xác nhận được loại bản cài đặt',
        firewall: 'Firewall theo trang cấp cao nhất',
        firewallAvailable: 'Có điều kiện DNR cần thiết (Chrome 145+)',
        firewallUnavailable: 'Cần Chrome 145+ hỗ trợ điều kiện DNR theo trang cấp cao nhất',
        body: 'Lọc và sửa nội dung response',
        dns: 'Phát hiện tên miền thật qua DNS/CNAME',
        inline: 'Firewall cho inline-script',
        unimplemented: 'Chưa được triển khai trong bản MV3 này',
        managed: 'Bộ lọc webRequest dành cho thiết bị quản lý',
        managedStatus: 'Chưa triển khai; điều kiện chính sách không tự kích hoạt bộ lọc khác',
        supplementary: 'Firewall chặn mạng trực tiếp (thử nghiệm)',
    } : {
        observation: 'Network request observation',
        observationAvailable: 'Available — capture starts only after Start in Logger',
        observationPermission: 'Optional permission not granted; enable in Logger',
        unavailable: 'Unavailable for this installation or browser',
        matches: 'Chrome native rule-match events',
        matchesAvailable: 'Available — unpacked installation',
        matchesUnconfirmed: 'API and permission detected; installation eligibility unconfirmed',
        firewall: 'Top-page dynamic firewall',
        firewallAvailable: 'Required native DNR conditions available (Chrome 145+)',
        firewallUnavailable: 'Requires Chrome 145+ with top-page DNR conditions',
        body: 'Response-body filtering and rewriting',
        dns: 'DNS/CNAME uncloaking',
        inline: 'Inline-script firewall',
        unimplemented: 'Not implemented in this MV3 build',
        managed: 'Managed-device webRequest engine',
        managedStatus: 'Not implemented; policy eligibility never activates another engine',
        supplementary: 'Direct network firewall (experimental)',
    };
    return [
        [ text.observation, capabilities.networkObservation === true ? text.observationAvailable :
            capabilities.networkObservationRequestable === true &&
            capabilities.networkObservationPermissionGranted !== true ? text.observationPermission : text.unavailable ],
        [ text.matches, capabilities.nativeMatchFeedback === true ? text.matchesAvailable :
            capabilities.nativeMatchFeedbackUnconfirmed === true ? text.matchesUnconfirmed : text.unavailable ],
        [ text.firewall, capabilities.topDomainFirewall === true ? text.firewallAvailable : text.firewallUnavailable ],
        [ text.body, text.unimplemented ],
        [ text.dns, text.unimplemented ],
        [ text.inline, text.unimplemented ],
        [ text.supplementary, webRequestFirewallStatusText(capabilities, language) ],
        [ text.managed, text.managedStatus ],
    ];
}
