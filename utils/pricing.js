const DEFAULT_PRICES = {
  'local-1on1': 1500, 'local-minigroup': 850, 'local-smallgroup': 500, 'local-largegroup': 400,
  'prep-g15-1on1': 18000, 'prep-g15-2to3': 12000, 'prep-g15-4to5': 8000, 'prep-g15-6to10': 5000,
  'prep-g6-1on1': 20000, 'prep-g6-2to3': 10000, 'prep-g6-4to5': 5000, 'prep-g6-6to10': 4000,
  'prep-g8-1on1': 21000, 'prep-g8-2to3': 12000, 'prep-g8-4to5': 7000, 'prep-g8-6to10': 6000,
  'prep-g12-1on1': 24000, 'prep-g12-2to3': 14000, 'prep-g12-4to5': 9000, 'prep-g12-6to10': 8000,
  'intl-1on1': 2500, 'intl-minigroup': 1500, 'intl-smallgroup': 1000, 'intl-largegroup': 700,
  'intl-prep-1on1': 30000, 'intl-prep-2to3': 20000, 'intl-prep-4to5': 10500, 'intl-prep-6to10': 5000,
};

const INTERNATIONAL_SUBJECTS = new Set([
  'ielts', 'toefl ibt', 'duolingo english test', 'pte academic', 'cambridge english', 'oet',
  'sat', 'act', 'gre', 'gmat', 'ap exams', 'international baccalaureate (ib)',
]);

function resolvePricingPlanId({ subject, grade, planType, session, groupSize }) {
  const subjects = Array.isArray(subject) ? subject : [subject];
  const international = subjects.some((value) =>
    INTERNATIONAL_SUBJECTS.has(String(value || '').trim().toLowerCase())
  );
  const size = session === 'group' ? Number(groupSize) : 1;
  const tier = size === 1 ? '1on1'
    : size >= 2 && size <= 3 ? '2to3'
      : size >= 4 && size <= 5 ? '4to5'
        : size >= 6 && size <= 10 ? '6to10' : null;
  if (!tier) return null;

  if (planType === 'monthly') {
    if (international) return 'intl-prep-' + tier;
    const gradeMatch = String(grade || '').match(/grade\s+(\d+)/i);
    if (!gradeMatch) return null;
    const gradeNum = Number(gradeMatch[1]);
    const gradeGroup = gradeNum >= 1 && gradeNum <= 5 ? 'g15'
      : gradeNum === 6 ? 'g6'
        : gradeNum === 8 ? 'g8'
          : gradeNum === 12 ? 'g12' : null;
    return gradeGroup ? 'prep-' + gradeGroup + '-' + tier : null;
  }

  if (!['hourly', 'weekly'].includes(planType)) return null;
  const hourlyTier = { '1on1': '1on1', '2to3': 'minigroup', '4to5': 'smallgroup', '6to10': 'largegroup' }[tier];
  return (international ? 'intl-' : 'local-') + hourlyTier;
}

function packageIdForSize(size) {
  if (size === 1) return 'premium-one-to-one';
  if (size === 2) return 'duo';
  if (size === 3) return 'mini-group';
  if (size <= 5) return 'small-group';
  return 'group-basic';
}

function resolveBookingPrice(details, prices = DEFAULT_PRICES) {
  const planId = resolvePricingPlanId(details);
  const rate = prices[planId];
  if (!planId || !Number.isSafeInteger(rate) || rate < 0) return null;

  const size = details.session === 'group' ? Number(details.groupSize) : 1;
  const durationHours = details.duration === '1.5 Hours' ? 1.5
    : details.duration === '2 Hours' ? 2
      : details.duration === '2 + Hours' ? 2.5 : 1;
  const selectedDays = Array.isArray(details.selectedDays) ? details.selectedDays.length
    : details.selectedDays ? 1 : 0;
  const weekly = details.planType === 'weekly';
  const amount = weekly ? rate * durationHours * selectedDays
    : details.planType === 'hourly' ? rate * durationHours : rate;
  if (!Number.isFinite(amount) || amount < 0) return null;

  const unit = details.planType === 'monthly' ? 'student/month'
    : weekly ? 'student/week'
      : size > 1 ? 'student/session' : 'session';
  const format = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(amount);
  const classSize = size === 1 ? '1 student' : size + ' students';
  return {
    planId,
    packageId: packageIdForSize(size),
    classSize,
    amount,
    rate,
    fee: format + ' ETB/' + unit,
  };
}

module.exports = { DEFAULT_PRICES, resolveBookingPrice, resolvePricingPlanId };
