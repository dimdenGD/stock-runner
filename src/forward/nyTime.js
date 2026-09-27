const OFFSET_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' });
const DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const offsets = new Map();

export function nyOffset(day) {
    if (!offsets.has(day)) {
        const parts = OFFSET_FMT.formatToParts(new Date(`${day}T12:00:00Z`));
        offsets.set(day, parts.find(p => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00');
    }
    return offsets.get(day);
}

export const etTime = (day, hhmm) => Date.parse(`${day}T${hhmm}:00${nyOffset(day)}`);

export function nyDate(ts = Date.now()) {
    return DATE_FMT.format(new Date(ts));
}

export function sessionOf(entry) {
    return { day: entry.date, open: etTime(entry.date, entry.open), close: etTime(entry.date, entry.close) };
}

export async function tradingSessions(broker, from, to) {
    return (await broker.getCalendar(from, to)).map(sessionOf);
}
