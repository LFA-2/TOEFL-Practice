// Dates in the learner's timezone (default Asia/Taipei).
const TZ = process.env.TZ_NAME || 'Asia/Taipei';

function today(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

function weekday(day) {
  return new Date(day + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
}

module.exports = { today, daysBetween, weekday, TZ };
