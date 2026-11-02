// research/trades — the trade taxonomy and the probe questions each trade asks.
//
// Two jobs, both deterministic:
//   1. Name the trades we prospect, map each to an AO vertical, and say which
//      Google Places categories mean that trade. No model in that loop: a
//      category either has a rule or the lead stays unclassified.
//   2. Build the buyer questions we put to the answer engines. The wording is
//      frozen and hashed, so an answer gathered today can be compared to one
//      gathered in March and we can prove the question did not drift.
//
// Change the wording of a question and you must bump QUESTION_SET_VERSION.
// Old rows keep their old sha and stay comparable among themselves; new rows
// carry the new one. Nothing silently mixes.

import { createHash } from 'node:crypto';
import type { Pair, ProbeQuestion, Trade } from './types.ts';

/** Bump this whenever a question's wording changes. Stored on every probe run. */
export const QUESTION_SET_VERSION = 'v1';

// The trades. `urgent` is null wherever a buyer emergency does not exist: you
// can have a roofing emergency, you cannot have a boutique emergency. That null
// halves the probe cost for the pair (four runs instead of eight).
//
// placesCategories are exact Google Places category strings. A category belongs
// to exactly one trade; when two trades could both claim one, the more specific
// trade takes it and the other leaves it out.
export const TRADES: Trade[] = [
  // ── Home services ──────────────────────────────────────────────────────────
  {
    slug: 'roofing',
    label: 'Roofing',
    vertical: 'home-services',
    noun: 'roofer',
    urgent: 'My roof is leaking after a storm',
    placesCategories: ['Roofing contractor', 'Roofing service', 'Roof repair service'],
  },
  {
    slug: 'hvac',
    label: 'HVAC',
    vertical: 'home-services',
    noun: 'HVAC contractor',
    urgent: 'My furnace stopped working',
    placesCategories: [
      'HVAC contractor',
      'Heating contractor',
      'Air conditioning contractor',
      'Air conditioning repair service',
      'Furnace repair service',
    ],
  },
  {
    slug: 'plumbing',
    label: 'Plumbing',
    vertical: 'home-services',
    noun: 'plumber',
    urgent: 'I have a burst pipe',
    placesCategories: [
      'Plumber',
      'Plumbing contractor',
      'Drain cleaning service',
      'Water heater installation service',
    ],
  },
  {
    slug: 'electrical',
    label: 'Electrical',
    vertical: 'home-services',
    noun: 'electrician',
    urgent: 'Half my house has no power',
    placesCategories: ['Electrician', 'Electrical installation service', 'Electrical repair shop'],
  },
  {
    slug: 'landscaping',
    label: 'Landscaping',
    vertical: 'home-services',
    noun: 'landscaper',
    urgent: null,
    placesCategories: [
      'Landscaper',
      'Landscape designer',
      'Landscape architect',
      'Lawn care service',
      'Sprinkler system contractor',
    ],
  },
  {
    slug: 'tree_service',
    label: 'Tree Service',
    vertical: 'home-services',
    noun: 'tree service',
    urgent: 'A tree came down on my house in the storm last night',
    placesCategories: ['Tree service', 'Arborist service', 'Stump grinding service'],
  },
  {
    slug: 'pest_control',
    label: 'Pest Control',
    vertical: 'home-services',
    noun: 'pest control company',
    urgent: 'I have mice getting into my kitchen',
    placesCategories: ['Pest control service', 'Exterminator'],
  },
  {
    slug: 'garage_doors',
    label: 'Garage Doors',
    vertical: 'home-services',
    noun: 'garage door company',
    urgent: 'My garage door will not open and my car is stuck inside',
    placesCategories: ['Garage door supplier', 'Garage door repair service'],
  },
  {
    slug: 'painting',
    label: 'Painting',
    vertical: 'construction-trades',
    noun: 'painter',
    urgent: null,
    placesCategories: ['Painter', 'House painter', 'Painting contractor'],
  },
  {
    slug: 'flooring',
    label: 'Flooring',
    vertical: 'construction-trades',
    noun: 'flooring company',
    urgent: null,
    placesCategories: [
      'Flooring contractor',
      'Flooring store',
      'Carpet installer',
      'Wood floor installation service',
      'Tile contractor',
    ],
  },
  {
    slug: 'cleaning',
    label: 'Cleaning',
    vertical: 'home-services',
    noun: 'house cleaning service',
    urgent: null,
    placesCategories: [
      'House cleaning service',
      'Commercial cleaning service',
      'Carpet cleaning service',
      'Janitorial service',
    ],
  },
  {
    slug: 'windows_siding',
    label: 'Windows & Siding',
    vertical: 'home-services',
    noun: 'window and siding company',
    urgent: null,
    placesCategories: ['Window installation service', 'Window supplier', 'Siding contractor'],
  },
  {
    slug: 'septic',
    label: 'Septic',
    vertical: 'home-services',
    noun: 'septic company',
    urgent: 'My septic system is backing up into the house',
    placesCategories: ['Septic system service', 'Septic tank pumping service'],
  },
  {
    slug: 'handyman',
    label: 'Handyman',
    vertical: 'home-services',
    noun: 'handyman',
    urgent: null,
    placesCategories: ['Handyman', 'Handyman/Handyperson'],
  },

  // ── Construction and trades ────────────────────────────────────────────────
  {
    slug: 'general_contractor',
    label: 'General Contractor',
    vertical: 'construction-trades',
    noun: 'general contractor',
    urgent: null,
    placesCategories: ['General contractor', 'Construction company', 'Home builder'],
  },
  {
    slug: 'remodeling',
    label: 'Remodeling',
    vertical: 'construction-trades',
    noun: 'remodeling contractor',
    urgent: null,
    placesCategories: ['Remodeler', 'Bathroom remodeler', 'Kitchen remodeler', 'Home improvement contractor'],
  },
  {
    slug: 'concrete',
    label: 'Concrete',
    vertical: 'construction-trades',
    noun: 'concrete contractor',
    urgent: null,
    placesCategories: ['Concrete contractor', 'Driveway contractor', 'Foundation contractor'],
  },
  {
    slug: 'excavation',
    label: 'Excavation',
    vertical: 'construction-trades',
    noun: 'excavation contractor',
    urgent: null,
    placesCategories: ['Excavating contractor', 'Demolition contractor', 'Grading service'],
  },
  {
    slug: 'fencing',
    label: 'Fencing',
    vertical: 'construction-trades',
    noun: 'fence company',
    urgent: null,
    placesCategories: ['Fence contractor', 'Deck builder'],
  },

  // ── Automotive ─────────────────────────────────────────────────────────────
  {
    slug: 'auto_repair',
    label: 'Auto Repair',
    vertical: 'automotive',
    noun: 'auto repair shop',
    urgent: 'My car broke down and I need it looked at today',
    placesCategories: [
      'Auto repair shop',
      'Car repair and maintenance service',
      'Brake shop',
      'Transmission shop',
      'Oil change service',
      'Tire shop',
    ],
  },
  {
    slug: 'auto_body',
    label: 'Auto Body',
    vertical: 'automotive',
    noun: 'auto body shop',
    urgent: 'I was just in a wreck and my car needs body work',
    placesCategories: ['Auto body shop', 'Auto dent removal service', 'Auto glass shop', 'Auto painting'],
  },
  {
    slug: 'towing',
    label: 'Towing',
    vertical: 'automotive',
    noun: 'towing company',
    urgent: 'My car will not start and I need a tow',
    placesCategories: ['Towing service', 'Roadside assistance service'],
  },

  // ── Health and wellness ────────────────────────────────────────────────────
  {
    slug: 'dental',
    label: 'Dental',
    vertical: 'health-wellness',
    noun: 'dentist',
    urgent: 'I cracked a tooth and I am in a lot of pain',
    placesCategories: ['Dentist', 'Dental clinic', 'Cosmetic dentist', 'Pediatric dentist', 'Orthodontist'],
  },
  {
    slug: 'chiropractic',
    label: 'Chiropractic',
    vertical: 'health-wellness',
    noun: 'chiropractor',
    urgent: 'I threw my back out and I can barely stand up',
    placesCategories: ['Chiropractor'],
  },
  {
    slug: 'physical_therapy',
    label: 'Physical Therapy',
    vertical: 'health-wellness',
    noun: 'physical therapist',
    urgent: null,
    placesCategories: ['Physical therapist', 'Physical therapy clinic', 'Sports medicine clinic'],
  },
  {
    slug: 'veterinary',
    label: 'Veterinary',
    vertical: 'health-wellness',
    noun: 'veterinarian',
    urgent: 'My dog is sick and needs to be seen today',
    placesCategories: ['Veterinarian', 'Veterinary care', 'Animal hospital', 'Emergency veterinarian service'],
  },

  // ── Professional services ──────────────────────────────────────────────────
  {
    slug: 'law',
    label: 'Law',
    vertical: 'professional-services',
    noun: 'lawyer',
    urgent: null,
    placesCategories: ['Law firm', 'Attorney', 'Personal injury attorney', 'Family law attorney', 'Estate planning attorney'],
  },
  {
    slug: 'accounting',
    label: 'Accounting',
    vertical: 'professional-services',
    noun: 'accountant',
    urgent: null,
    placesCategories: ['Accountant', 'Certified public accountant', 'Tax preparation service', 'Bookkeeping service'],
  },
  {
    slug: 'insurance',
    label: 'Insurance',
    vertical: 'professional-services',
    noun: 'insurance agent',
    urgent: null,
    placesCategories: ['Insurance agency', 'Insurance broker', 'Auto insurance agency'],
  },

  // ── Real estate and property ───────────────────────────────────────────────
  {
    slug: 'real_estate',
    label: 'Real Estate',
    vertical: 'real-estate-property',
    noun: 'real estate agent',
    urgent: null,
    placesCategories: ['Real estate agency', 'Real estate agent', 'Real estate consultant'],
  },
  {
    slug: 'property_management',
    label: 'Property Management',
    vertical: 'real-estate-property',
    noun: 'property manager',
    urgent: null,
    placesCategories: ['Property management company', 'Apartment rental agency'],
  },
  {
    slug: 'home_inspection',
    label: 'Home Inspection',
    vertical: 'real-estate-property',
    noun: 'home inspector',
    urgent: null,
    placesCategories: ['Home inspector', 'Building inspector'],
  },

  // ── Personal care and fitness ──────────────────────────────────────────────
  {
    slug: 'salon',
    label: 'Salon',
    vertical: 'personal-care',
    noun: 'hair salon',
    urgent: null,
    placesCategories: ['Hair salon', 'Beauty salon'],
    nameHints: ['hair', 'salon'],
  },
  {
    slug: 'fitness',
    label: 'Fitness',
    vertical: 'personal-care',
    noun: 'gym',
    urgent: null,
    placesCategories: ['Gym', 'Fitness center', 'Personal trainer', 'Athletic club', 'Recreation center'],
    nameHints: ['fitness', 'gym', 'athletic club'],
  },

  // ── Food and hospitality ───────────────────────────────────────────────────
  {
    slug: 'restaurant',
    label: 'Restaurant',
    vertical: 'food-hospitality',
    noun: 'restaurant',
    urgent: null,
    placesCategories: ['Restaurant', 'Diner', 'Bar & grill', 'American restaurant', 'Bistro', 'Chinese restaurant', 'Takeout Restaurant'],
    nameHints: ['restaurant', 'grill', 'roadhouse', 'bistro', 'eatery', 'diner', 'steakhouse'],
  },
  {
    slug: 'coffee',
    label: 'Coffee',
    vertical: 'food-hospitality',
    noun: 'coffee shop',
    urgent: null,
    placesCategories: ['Coffee shop', 'Cafe', 'Espresso bar', 'Coffee store', 'Coffeehouse'],
    nameHints: ['coffee', 'coffeehouse', 'espresso'],
  },
  {
    slug: 'brewery',
    label: 'Brewery',
    vertical: 'food-hospitality',
    noun: 'brewery',
    urgent: null,
    placesCategories: ['Brewery', 'Brewpub', 'Taproom'],
  },

  // ── Retail and specialty ───────────────────────────────────────────────────
  {
    slug: 'retail',
    label: 'Retail',
    vertical: 'retail-specialty',
    noun: 'shop',
    urgent: null,
    placesCategories: ['Furniture store', 'Hardware store', 'Store', 'Department store', 'Dollar store', 'Home goods store', 'Convenience store'],
  },

  // ── Outdoor and recreation ─────────────────────────────────────────────────
  {
    slug: 'outfitter',
    label: 'Outfitter',
    vertical: 'outdoor-recreation',
    noun: 'outfitter',
    urgent: null,
    placesCategories: ['Outfitter', 'Guide service'],
    nameHints: ['outfitter', 'outfitting', 'guide service', 'adventure'],
  },

  // The catch-all. A lead we know is a business and nothing more. It still gets
  // the best question, because "who is the best business in town" is useless and
  // Added after the first classify pass over the pond called these "other".
  { slug: 'window_cleaning', label: 'Window cleaning', vertical: 'home-services', noun: 'window cleaning company', urgent: null, placesCategories: ['Window cleaning service', 'Pressure washing service', 'Gutter cleaning service'] },
  { slug: 'bakery', label: 'Bakery', vertical: 'food-hospitality', noun: 'bakery', urgent: null, placesCategories: ['Bakery', 'Pastry shop', 'Donut shop'], nameHints: ['bakery', 'bakeshop', 'bakehouse', 'pastry', 'cakes', 'donuts', 'doughnuts', 'bread'] },
  { slug: 'it_services', label: 'IT services', vertical: 'professional-services', noun: 'IT support company', urgent: 'My office computers are down and I need IT help today', placesCategories: ['Computer support and services', 'Computer repair service', 'Computer consultant'] },
  { slug: 'counseling', label: 'Counseling', vertical: 'health-wellness', noun: 'therapist', urgent: null, placesCategories: ['Counselor', 'Psychotherapist', 'Mental health service', 'Marriage or relationship counselor', 'Family counselor'] },
  { slug: 'audiology', label: 'Audiology', vertical: 'health-wellness', noun: 'hearing clinic', urgent: null, placesCategories: ['Audiologist', 'Hearing aid store', 'Hearing aid repair service'] },
  { slug: 'marketing_agency', label: 'Marketing agency', vertical: 'professional-services', noun: 'marketing agency', urgent: null, placesCategories: ['Marketing agency', 'Advertising agency', 'Internet marketing service', 'Website designer'] },
  { slug: 'med_spa', label: 'Med spa', vertical: 'personal-care', noun: 'med spa', urgent: null, placesCategories: ['Medical spa', 'Laser hair removal service', 'Skin care clinic'] },
  { slug: 'optometry', label: 'Optometry', vertical: 'health-wellness', noun: 'eye doctor', urgent: null, placesCategories: ['Optometrist', 'Eye care center', 'Optician'] },
  // Added after the pond's first full classify pass: the health side of the
  // AO is bigger than the taxonomy allowed for.
  { slug: 'home_health', label: 'Home health care', vertical: 'health-wellness', noun: 'home health care agency', urgent: null, placesCategories: ['Home health care service', 'Home help service agency', 'Hospice', 'Assisted living facility', 'Senior citizen center'] },
  { slug: 'massage', label: 'Massage', vertical: 'health-wellness', noun: 'massage therapist', urgent: null, placesCategories: ['Massage therapist', 'Massage spa'], nameHints: ['massage'] },
  { slug: 'medical_clinic', label: 'Medical clinic', vertical: 'health-wellness', noun: 'doctor', urgent: 'I need to see a doctor today without an appointment', placesCategories: ['Medical clinic', 'Medical Center', 'Family practice physician', 'Urgent care center', 'Walk-in clinic', 'Doctor'] },
  { slug: 'nail_salon', label: 'Nail salon', vertical: 'personal-care', noun: 'nail salon', urgent: null, placesCategories: ['Nail salon'], nameHints: ['nails', 'nail salon', 'nail spa'] },
  // ── Added 2026-09-05: the question has to be the one a person would ask ──
  // Griffin: "it ran 'best hair salon' for a BARBERSHOP. it ran 'best gym'
  // for a YOGA STUDIO ... a human would be slightly more specific." A coarse
  // bucket asked the wrong question of the engines for every lead under it,
  // so the buckets are split where a buyer's own words differ.
  { slug: 'barbershop', label: 'Barbershop', vertical: 'personal-care', noun: 'barbershop', urgent: null, placesCategories: ['Barber shop', 'Barbershop'], nameHints: ['barber', 'barbershop', 'shave'] },
  { slug: 'day_spa', label: 'Day spa', vertical: 'personal-care', noun: 'day spa', urgent: null, placesCategories: ['Day spa', 'Spa', 'Facial spa'], nameHints: ['day spa', 'esthetics', 'aesthetics', 'skincare', 'skin care'] },
  { slug: 'tattoo', label: 'Tattoo', vertical: 'personal-care', noun: 'tattoo shop', urgent: null, placesCategories: ['Tattoo shop', 'Tattoo and piercing shop'], nameHints: ['tattoo', 'ink'] },
  { slug: 'yoga', label: 'Yoga', vertical: 'personal-care', noun: 'yoga studio', urgent: null, placesCategories: ['Yoga studio'], nameHints: ['yoga', 'zen den'] },
  { slug: 'pilates', label: 'Pilates', vertical: 'personal-care', noun: 'pilates studio', urgent: null, placesCategories: ['Pilates studio'], nameHints: ['pilates'] },
  { slug: 'crossfit', label: 'CrossFit', vertical: 'personal-care', noun: 'CrossFit gym', urgent: null, placesCategories: ['CrossFit box'], nameHints: ['crossfit'] },
  { slug: 'pizza', label: 'Pizza', vertical: 'food-hospitality', noun: 'pizza place', urgent: null, placesCategories: ['Pizza restaurant', 'Pizzeria'], nameHints: ['pizza', 'pizzeria'] },
  { slug: 'mexican', label: 'Mexican restaurant', vertical: 'food-hospitality', noun: 'Mexican restaurant', urgent: null, placesCategories: ['Mexican restaurant', 'Taqueria', 'Taco restaurant'], nameHints: ['taqueria', 'cocina', 'cantina', 'taco', 'mexican'] },
  { slug: 'bbq', label: 'Barbecue', vertical: 'food-hospitality', noun: 'barbecue restaurant', urgent: null, placesCategories: ['Barbecue restaurant'], nameHints: ['bbq', 'barbecue', 'smokehouse', 'rib', 'ribs'] },
  { slug: 'deli', label: 'Deli', vertical: 'food-hospitality', noun: 'deli', urgent: null, placesCategories: ['Deli', 'Delicatessen', 'Sandwich shop', 'Bagel shop'], nameHints: ['deli', 'delicatessen', 'bagel', 'bagels', 'sandwich'] },
  { slug: 'burger', label: 'Burgers', vertical: 'food-hospitality', noun: 'burger place', urgent: null, placesCategories: ['Hamburger restaurant'], nameHints: ['burger', 'burgers', 'drive in'] },
  { slug: 'caterer', label: 'Caterer', vertical: 'food-hospitality', noun: 'caterer', urgent: null, placesCategories: ['Caterer'], nameHints: ['catering', 'caterer'] },
  { slug: 'winery', label: 'Winery', vertical: 'food-hospitality', noun: 'winery', urgent: null, placesCategories: ['Winery', 'Vineyard', 'Wine bar'], nameHints: ['winery', 'vineyard', 'vineyards', 'cellars', 'cider'] },
  { slug: 'lodging', label: 'Lodging', vertical: 'food-hospitality', noun: 'hotel', urgent: null, placesCategories: ['Hotel', 'Motel', 'Bed & breakfast', 'Inn', 'Lodge'], nameHints: ['hotel', 'motel', 'inn', 'lodge', 'bed and breakfast', 'b&b'] },
  { slug: 'rv_park', label: 'RV park', vertical: 'outdoor-recreation', noun: 'RV park', urgent: null, placesCategories: ['RV park', 'Campground'], nameHints: ['rv park', 'rv resort', 'campground'] },
  { slug: 'bike_shop', label: 'Bike shop', vertical: 'outdoor-recreation', noun: 'bike shop', urgent: null, placesCategories: ['Bicycle Shop', 'Bicycle store', 'Bicycle repair shop'], nameHints: ['bike', 'bikes', 'bicycle', 'cycle', 'cycles', 'cyclery', 'bikeworks'] },
  { slug: 'ski_shop', label: 'Ski shop', vertical: 'outdoor-recreation', noun: 'ski shop', urgent: null, placesCategories: ['Ski shop', 'Ski rental service', 'Snowboard shop'], nameHints: ['ski', 'snowboard'] },
  { slug: 'rafting', label: 'Rafting', vertical: 'outdoor-recreation', noun: 'rafting company', urgent: null, placesCategories: ['Rafting', 'Raft trip outfitter'], nameHints: ['rafting', 'raft'] },
  { slug: 'fly_shop', label: 'Fly shop', vertical: 'outdoor-recreation', noun: 'fly fishing shop', urgent: null, placesCategories: ['Fishing store', 'Fly fishing outfitter'], nameHints: ['fly shop', 'anglers', 'fly fishing'] },
  { slug: 'outdoor_gear', label: 'Outdoor gear', vertical: 'outdoor-recreation', noun: 'outdoor gear store', urgent: null, placesCategories: ['Outdoor clothing and equipment shop', 'Outdoor sports store', 'Camping store', 'Outerwear store'], nameHints: ['outdoor', 'outdoors', 'provisions', 'gear'] },
  { slug: 'sporting_goods', label: 'Sporting goods', vertical: 'retail-specialty', noun: 'sporting goods store', urgent: null, placesCategories: ['Sporting goods store'], nameHints: ['sporting goods', 'sports'] },
  { slug: 'powersports', label: 'Powersports', vertical: 'retail-specialty', noun: 'powersports dealer', urgent: null, placesCategories: ['Motorcycle shop', 'ATV dealer', 'Motorsports store'], nameHints: ['motorsports', 'powersports', 'motorcycle', 'atv', 'utv', 'snowmobile', 'jet ski'] },
  { slug: 'gun_shop', label: 'Gun shop', vertical: 'retail-specialty', noun: 'gun shop', urgent: null, placesCategories: ['Gun shop'], nameHints: ['arms', 'firearms', 'gun', 'guns'] },
  { slug: 'florist', label: 'Florist', vertical: 'retail-specialty', noun: 'florist', urgent: null, placesCategories: ['Florist'], nameHints: ['floral', 'florist', 'flowers'] },
  { slug: 'jeweler', label: 'Jeweler', vertical: 'retail-specialty', noun: 'jeweler', urgent: null, placesCategories: ['Jeweler', 'Jewelry store'], nameHints: ['jewelers', 'jeweler', 'jewelry', 'silversmith', 'silversmiths'] },
  { slug: 'garden_center', label: 'Garden center', vertical: 'retail-specialty', noun: 'garden center', urgent: null, placesCategories: ['Garden center', 'Plant nursery'], nameHints: ['garden center', 'gardens', 'nursery'] },
  { slug: 'boutique', label: 'Boutique', vertical: 'retail-specialty', noun: 'boutique', urgent: null, placesCategories: ['Boutique', 'Clothing store', "Women's clothing store", 'Fashion accessories store'], nameHints: ['boutique'] },
  { slug: 'smoke_shop', label: 'Smoke shop', vertical: 'retail-specialty', noun: 'smoke shop', urgent: null, placesCategories: ['Tobacco shop', 'Cigar shop', 'Vaporizer store', 'Vape shop'], nameHints: ['smoke shop', 'vape', 'tobacco', 'cigar', 'cigars'] },
  { slug: 'hot_tub', label: 'Hot tubs', vertical: 'construction-trades', noun: 'hot tub dealer', urgent: null, placesCategories: ['Hot tub store', 'Hot tub repair service', 'Swimming pool supply store'], nameHints: ['hot tub', 'hot tubs'] },
  { slug: 'chocolate', label: 'Chocolate shop', vertical: 'retail-specialty', noun: 'chocolate shop', urgent: null, placesCategories: ['Chocolate shop', 'Chocolate artisan', 'Candy store'], nameHints: ['chocolate', 'chocolates', 'toffee', 'confections', 'candy', 'fudge'] },
  { slug: 'gift_shop', label: 'Gift shop', vertical: 'retail-specialty', noun: 'gift shop', urgent: null, placesCategories: ['Gift shop', 'Souvenir store'], nameHints: ['gift', 'gifts'] },
  { slug: 'art_gallery', label: 'Art gallery', vertical: 'retail-specialty', noun: 'art gallery', urgent: null, placesCategories: ['Art gallery'], nameHints: ['gallery', 'fine art'] },
  { slug: 'antiques', label: 'Antiques', vertical: 'retail-specialty', noun: 'antique store', urgent: null, placesCategories: ['Antique store'], nameHints: ['antique', 'antiques'] },
  { slug: 'dispensary', label: 'Dispensary', vertical: 'retail-specialty', noun: 'dispensary', urgent: null, placesCategories: ['Cannabis store'], nameHints: ['dispensary', 'cannabis'] },
  { slug: 'liquor_store', label: 'Liquor store', vertical: 'retail-specialty', noun: 'liquor store', urgent: null, placesCategories: ['Liquor store'], nameHints: ['liquor', 'liquors', 'spirits'] },
  { slug: 'grocery', label: 'Grocery', vertical: 'retail-specialty', noun: 'grocery store', urgent: null, placesCategories: ['Grocery store', 'Health food store', 'Market'], nameHints: ['grocery', 'supermarket', 'foods'] },
  { slug: 'title_company', label: 'Title company', vertical: 'real-estate-property', noun: 'title company', urgent: null, placesCategories: ['Title company'], nameHints: ['title company', 'title & closing', 'title and closing', 'title'] },
  { slug: 'appraiser', label: 'Appraiser', vertical: 'real-estate-property', noun: 'home appraiser', urgent: null, placesCategories: ['Real estate appraiser'], nameHints: ['appraisal', 'appraisals', 'appraiser'] },
  { slug: 'mortgage', label: 'Mortgage', vertical: 'professional-services', noun: 'mortgage lender', urgent: null, placesCategories: ['Mortgage lender', 'Mortgage broker'], nameHints: ['mortgage', 'lending', 'home loans'] },
  { slug: 'drywall', label: 'Drywall', vertical: 'construction-trades', noun: 'drywall contractor', urgent: null, placesCategories: ['Drywall contractor'], nameHints: ['drywall'] },
  { slug: 'masonry', label: 'Masonry', vertical: 'construction-trades', noun: 'masonry contractor', urgent: null, placesCategories: ['Masonry contractor'], nameHints: ['masonry', 'stonework'] },
  { slug: 'pet_grooming', label: 'Pet grooming', vertical: 'personal-care', noun: 'dog groomer', urgent: null, placesCategories: ['Pet groomer'], nameHints: ['groomer', 'grooming'] },
  // the caller is expected to skip it rather than the taxonomy pretending.
  {
    slug: 'other',
    label: 'Other',
    vertical: 'professional-services',
    noun: 'business',
    urgent: null,
    placesCategories: [],
  },
];

const BY_SLUG = new Map<string, Trade>(TRADES.map((t) => [t.slug, t]));

const BY_CATEGORY = new Map<string, Trade>(
  TRADES.flatMap((t) => t.placesCategories.map((c) => [c.toLowerCase(), t] as [string, Trade])),
);

/** Look a trade up by its stored slug. Null rather than a guess. */
export function tradeBySlug(slug: string | null | undefined): Trade | null {
  const key = (slug ?? '').trim().toLowerCase();
  if (!key) return null;
  return BY_SLUG.get(key) ?? null;
}

/**
 * The trade a Google Places category means, or null. Exact match only: a
 * category we have no rule for is unclassified, never approximated. Adding a
 * rule is cheap; a wrong trade poisons every question we then ask.
 */
export function tradeFromPlacesCategory(category: string | null | undefined): Trade | null {
  const key = (category ?? '').trim().toLowerCase();
  if (!key) return null;
  return BY_CATEGORY.get(key) ?? null;
}

/** The folded name: lowercase, punctuation to spaces, one space between words. */
function foldName(name: string | null | undefined): string {
  return ` ${(name ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/**
 * The trade a business NAME settles on its own: "Half Moon Yoga" is a yoga
 * studio, "Finesse Barbershop" is a barbershop, whatever category Google
 * put on it. Only trades that carry nameHints take part, and a longer hint
 * beats a shorter one ("day spa" before "spa", "fly shop" before "shop"), so
 * the most specific reading wins. Null when no hint matches.
 */
export function tradeFromName(businessName: string | null | undefined): Trade | null {
  return tradesFromName(businessName)[0] ?? null;
}

/** Every trade the name hints at, longest hint first. Empty when the name says nothing. */
export function tradesFromName(businessName: string | null | undefined): Trade[] {
  const folded = foldName(businessName);
  if (folded.trim().length === 0) return [];
  const hits = new Map<string, { trade: Trade; len: number }>();
  for (const t of TRADES) {
    for (const hint of t.nameHints ?? []) {
      const h = foldName(hint);
      if (!folded.includes(h)) continue;
      const prev = hits.get(t.slug);
      if (!prev || h.length > prev.len) hits.set(t.slug, { trade: t, len: h.length });
    }
  }
  // A specific trade outranks a coarse bucket ("Pinon Pizza Kitchen & Restaurant"
  // is a pizza place), then the longer hint wins.
  const rank = (h: { trade: Trade; len: number }) => (COARSE_TRADES.includes(h.trade.slug) ? 0 : 1000) + h.len;
  return [...hits.values()].sort((a, b) => rank(b) - rank(a)).map((h) => h.trade);
}

/** The trades that were catch-alls before the taxonomy was split. A lead under one may belong somewhere more specific. */
export const COARSE_TRADES: readonly string[] = ['salon', 'fitness', 'restaurant', 'retail', 'outfitter', 'other', 'bakery'] as const;

/**
 * A more specific trade for a lead already filed under a coarse one, or null
 * when the record is fine as it is. The category rule first (exact, free),
 * then the name. Never moves a lead OUT of a specific trade, and never moves
 * one INTO 'other'.
 */
export function refineTrade(lead: {
  trade: string | null;
  business_name: string | null;
  places_category: string | null;
  source_detail?: string | null;
}): Trade | null {
  if (!lead.trade || !COARSE_TRADES.includes(lead.trade)) return null;
  const specific = (t: Trade | null | undefined): Trade | null => (t && !COARSE_TRADES.includes(t.slug) ? t : null);
  // The name first: it is what the business calls itself, and an owner's
  // Google category is often chosen for search reach ("Caterer" on a deli).
  // But a name that also says the bucket it is in ("Posh Salon & Boutique")
  // is ambiguous, and the name gets no vote.
  const named = tradesFromName(lead.business_name);
  const namedSpecific = named.filter((t) => !COARSE_TRADES.includes(t.slug));
  const nameIsAmbiguous = named.some((t) => t.slug === lead.trade) || namedSpecific.length > 1;
  let next = nameIsAmbiguous ? null : specific(namedSpecific[0]);
  // Then the category, but only when it names something specific: "Hair
  // salon" on a lead already filed under salon says nothing new.
  if (!next) next = specific(tradeFromPlacesCategory(lead.places_category));
  if (!next) {
    for (const part of (lead.source_detail ?? '').split(' · ')) {
      next = specific(tradeFromPlacesCategory(part));
      if (next) break;
    }
  }
  if (!next || next.slug === lead.trade) return null;
  return next;
}

const STATE_NAMES: Record<string, string> = {
  CO: 'Colorado',
  UT: 'Utah',
  NM: 'New Mexico',
  WY: 'Wyoming',
  AZ: 'Arizona',
};

/** Spell a state out for a question a person would actually type. Unknown codes pass through. */
export function stateName(code: string): string {
  const key = code.trim().toUpperCase();
  return STATE_NAMES[key] ?? code;
}

/** sha256 of the question with whitespace collapsed, so formatting never changes the hash. */
export function questionSha(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * The questions we put to every engine for one trade in one town. Always the
 * "best" question; the "urgent" one only where an emergency is a real thing a
 * buyer would say out loud.
 */
export function probeQuestions(trade: Trade, city: string, state: string): ProbeQuestion[] {
  const where = `${city}, ${stateName(state)}`;
  const questions: ProbeQuestion[] = [
    {
      id: 'best',
      text: `Who is the best ${trade.noun} in ${where}? Name specific companies.`,
      sha: '',
    },
  ];
  if (trade.urgent !== null) {
    questions.push({
      id: 'urgent',
      text: `${trade.urgent} in ${where}. Who should I call? Give specific business names.`,
      sha: '',
    });
  }
  return questions.map((q) => ({ ...q, sha: questionSha(q.text) }));
}

// Words that stay lowercase inside a city name would be nice, but no AO town
// needs one, and "De Beque" proves the naive rule is the right one: capitalize
// every word, keep "New Castle" and "De Beque" correct.
function titleCaseCity(city: string): string {
  return city
    .split(' ')
    .map((word) =>
      word
        .split('-')
        .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part))
        .join('-'),
    )
    .join(' ');
}

/**
 * The city and state half of a pair key, normalized so "grand junction" and
 * "Grand  Junction " are the same probe batch. Null when there is no city:
 * a pair without a town is not a question anyone can ask.
 */
export function pairKey(city: string | null | undefined, state: string | null | undefined): Pair | null {
  const cleanCity = (city ?? '').trim().replace(/\s+/g, ' ');
  if (!cleanCity) return null;
  const cleanState = (state ?? '').trim().replace(/\s+/g, ' ').toUpperCase() || 'CO';
  return { trade: '', city: titleCaseCity(cleanCity), state: cleanState };
}

/** The full pair key. The trade is passed in trimmed and lowercased by the caller's slug. */
export function toPair(trade: string, city: string, state?: string | null): Pair | null {
  const base = pairKey(city, state ?? null);
  if (!base) return null;
  const cleanTrade = trade.trim().toLowerCase();
  if (!cleanTrade) return null;
  return { ...base, trade: cleanTrade };
}
