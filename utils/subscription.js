const DAY_MS = 24 * 60 * 60 * 1000;

function calculateSubscription({ planType, selectedDays }) {
  if (planType !== 'weekly' && planType !== 'monthly') {
    return { frequency: null, weeklySessions: 0 };
  }

  const days = Array.isArray(selectedDays) ? selectedDays.length : 0;
  if (!days) throw new Error('Please select at least one study day for your subscription.');

  return {
    frequency: planType,
    weeklySessions: days,
  };
}

function subscriptionEndDate(startDate, frequency) {
  const end = new Date(startDate);
  end.setTime(end.getTime() + (frequency === 'weekly' ? 7 : 30) * DAY_MS);
  return end;
}

module.exports = { calculateSubscription, subscriptionEndDate };
