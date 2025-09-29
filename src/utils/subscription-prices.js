const subscriptionPrices = {
  'Netflix Standard': 1700,
  'Netflix Premium': 2500,
  'Hulu + Live TV (2 Users Max)': 60000,
  'Hulu + Live TV with Unlimited Screens (3+ Users)': 69750,
  'Disney+ Premium': 5700,
  'Amazon Prime Video Household Sharing': 800,
  'HBO Max Ad-Free': 12500,
  'Apple TV+ Family Sharing': 300,
  'Paramount+ Premium': 9000,
  'Peacock Premium': 6000,
  'Crunchyroll Mega Fan': 750,
  'Crunchyroll Ultimate Fan': 9000,
  'Sling TV Blue': 20000,
  'Sling Orange & Blue': 27700,
  'YouTube Premium Family': 600,
  //  'Spotify Duo': 270,
  'Spotify Family': 750,
  'Apple Music Family': 300,
  'Amazon Music Unlimited Family': 4400,
  'YouTube Music Family': 570,
  'Tidal HiFi Family': 400,
  'Deezer Family': 370,
  'Pandora Premium Family': 4400,
  'LinkedIn Learning Teams (multi-user)': 45000,
  'Skillshare Teams (multi-user)': 20000,
  'Peloton All-Access (household)': 5000,
  'Calm Family Plan': 30000,
  'Headspace Family Plan': 30000,
  'Apple Fitness+ Family': 250,
  'Xbox Game Pass Friends & Family': 5000,
  'PlayStation Plus (Family accounts)': 500,
  'Nintendo Switch Online Family': 650,
  'Google One Family': 380,
  'Microsoft 365 Family': 700,
  'Dropbox Family': 1000,
  'iCloud+ Family Sharing': 200,
  'NYT Household Sharing': 1600,
  'Audible Household Library': 1250,
  'Scribd Family': 600,
  'Kindle Unlimited Household Sharing': 900,
  'Canva for Teams (multi-user)': 4000,
  'Adobe Creative Cloud Teams (multi-user)': 10000,
  'ABCmouse': 750,
  'Epic!': 680
};

const planIdMap = Object.keys(subscriptionPrices).reduce((acc, plan, index) => {
  acc[plan] = `P${index}`;
  return acc;
}, {});

export default subscriptionPrices;
export { planIdMap };