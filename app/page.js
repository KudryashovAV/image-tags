import TagPopup from "./components/TagPopup";

function getNumbersArrayUpToN(n) {
  const numbers = [];
  for (let i = 24; i <= n; i++) {
    numbers.push(i);
  }
  return numbers;
}

async function fetchSequentially(url, dates) {
  const urls = dates.map((date) => {
    return url + date + ".json";
  });

  const results = [];
  for (const url of urls) {
    const response = await fetch(url);
    let data = {};

    if (!response.ok) {
      data = { version: 0, levels: [] };
    } else {
      data = await response.json();
    }

    results.push(data);
  }
  return results;
}

const prepareId = (url, type, id) => {
  const originalString = id;

  const parts = originalString.split("_");

  const year = parts[0];
  const month = parts[1];
  const day = parts[2];

  const lastTwoDigitsOfYear = year.substring(2);

  const transformedString = `${url}${month}_${lastTwoDigitsOfYear}/${originalString}_Low.jpg|${type}|${originalString}`;

  return transformedString;
};

const showTagsWithIdFor = async (url, type, imageUrl) => {
  const currentDate = new Date();
  const fullYear = currentDate.getFullYear();
  const lastTwoDigitsOfYear = fullYear % 100;

  const years = getNumbersArrayUpToN(lastTwoDigitsOfYear);
  const months = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

  const dates = years
    .map((year) => {
      return months.map((month) => {
        return `${month}_${year}`;
      });
    })
    .flat();

  const raw_images_data = await fetchSequentially(url, dates);

  const all_images = [];
  raw_images_data.map((data) => {
    if (data.levels.length != 0) {
      return all_images.push(data.levels);
    }
  });

  const tagsToIds = all_images.flat().reduce((accumulator, currentObject) => {
    currentObject.tags.forEach((tag) => {
      if (!accumulator[tag]) {
        accumulator[tag] = [];
      }
      accumulator[tag].push(prepareId(imageUrl, type, currentObject.id));
    });
    return accumulator;
  }, {});

  return tagsToIds;
};

export default async function Home() {
  const tagsData = await showTagsWithIdFor(
    "https://storage.googleapis.com/malpa-static/jigsawgram/daily_config/levels_chunk_",
    "daily",
    "https://storage.googleapis.com/malpa-static/jigsawgram/daily/"
  );
  // const tagsData2 = await showTagsWithIdFor(
  //   "https://storage.googleapis.com/malpa-static/jigsawgram/puzzles_config/levels_chunk_",
  //   "puzzle",
  //   "https://storage.googleapis.com/malpa-static/jigsawgram/daily/"
  ("https://storage.googleapis.com/malpa-static/jigsawgram/puzzles/01_25/1655_Low.jpg");
  // );

  return (
    <div className="font-sans grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen mt-35 p-8 pb-20 gap-16 sm:p-20">
      <TagPopup tagsData={tagsData} />
    </div>
  );
}
