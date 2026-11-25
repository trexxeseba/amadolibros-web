/** Same syntax rules in browser and API. This does not verify ownership. */
export function createContactValidation() {
    function validEmail(value) {
        return typeof value === 'string' && value.trim().length <= 254 &&
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
    }
    function validPhone(value) {
        if (typeof value !== 'string') return false;
        const raw = value.trim();
        if (!raw || raw.length > 40 || !/^\+?[\d ().-]+$/.test(raw)) return false;
        const digits = raw.replace(/\D/g, '');
        if (/^(\d)\1+$/.test(digits)) return false;
        // Local landlines/mobile numbers, including the domestic mobile 0.
        if (/^[24]\d{7}$/.test(digits) || /^0?9\d{7}$/.test(digits)) return true;
        if (/^598[249]\d{7}$/.test(digits) || /^00598[249]\d{7}$/.test(digits)) return true;
        // Customers abroad can order for delivery in Uruguay. Require a
        // country prefix for foreign numbers instead of guessing a country.
        return (/^\+[1-9]\d{7,14}$/.test(raw.replace(/[ ().-]/g, '')) && !digits.startsWith('598')) ||
            (/^00[1-9]\d{7,14}$/.test(digits) && !digits.startsWith('00598'));
    }
    function replyContact(value) {
        if (validEmail(value)) return { type: 'email', value: value.trim().toLowerCase() };
        if (validPhone(value)) return { type: 'whatsapp', value: value.trim() };
        return null;
    }
    return { validEmail, validPhone, replyContact };
}

export const contactValidation = createContactValidation();
