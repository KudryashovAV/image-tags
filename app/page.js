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

const prepareId2 = (url, type, date_open, puzzle_start_price, id) => {
  const originalString = date_open;

  const parts = originalString.split("-");

  const month = parts[1];
  const year = parts[2];

  const transformedString = `${url}${month}_${year}/${id}_Low.jpg|${type}|${id}|${puzzle_start_price}`;

  return transformedString;
};

const showTagsWithIdFor2 = async (url, type, imageUrl) => {
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
      accumulator[tag].push(
        prepareId2(imageUrl, type, currentObject.date_open, currentObject.puzzle_start_price, currentObject.id)
      );
    });
    return accumulator;
  }, {});

  return tagsToIds;
};

function mergeObjectsWithArrays(obj1, obj2) {
  const result = { ...obj1 };

  for (const [key, value] of Object.entries(obj2)) {
    if (result[key]) {
      result[key] = [...new Set([...result[key], ...value])];
    } else {
      result[key] = value;
    }
  }

  return result;
}

export default async function Home() {
  const tagsData = await showTagsWithIdFor(
    "https://storage.googleapis.com/malpa-static/jigsawgram/daily_config/levels_chunk_",
    "daily",
    "https://storage.googleapis.com/malpa-static/jigsawgram/daily/"
  );
  const tagsData2 = await showTagsWithIdFor2(
    "https://storage.googleapis.com/malpa-static/jigsawgram/puzzles_config/levels_chunk_",
    "puzzle",
    "https://storage.googleapis.com/malpa-static/jigsawgram/puzzles/"
  );

  console.log("tagsData2", tagsData2);

  const finalData = mergeObjectsWithArrays(tagsData, tagsData2);

  return (
    <div className="fixed top-[50px] left-[100px] w-[calc(100vw-100px)] h-[calc(100vh-70px)]">
      <TagPopup tagsData={finalData} />
    </div> /* sss  */
  );
}
