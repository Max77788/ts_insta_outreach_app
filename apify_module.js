import { ApifyClient } from "apify-client";
import dotenv from "dotenv";
dotenv.config();

const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;

// Initialize the ApifyClient with API token
const client = new ApifyClient({
  token: APIFY_API_TOKEN,
});

const search_insta_profiles = async (search_term) => {

// Prepare Actor input
const input = {
  search: search_term,
  searchType: "hashtag",
  searchLimit: 1,
};
  // Run the Actor and wait for it to finish
  const run = await client.actor("DrF9mzPPEuVizVF4l").call(input);

  // Fetch and print Actor results from the run's dataset (if any)
  console.log("Results from dataset");
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return items;
};

/*
const results = await search_insta_profiles("fitness");

console.log(JSON.stringify(results));
*/

export { search_insta_profiles };