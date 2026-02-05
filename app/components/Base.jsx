import MainPage from "./MainPage";

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
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
      },
    });
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

const isItFuture = (dateString) => {
  const targetDate = new Date(dateString.replace(/_/g, "-"));
  const today = new Date();

  const targetDateOnly = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
  const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  return targetDateOnly.getTime() - todayOnly.getTime() > 0;
};

const isItFuture2 = (dateString) => {
  const date = dateString.split("-");

  const targetDate = new Date([date[1], date[0], date[2]].join("-"));
  const today = new Date();

  const targetDateOnly = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
  const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  return targetDateOnly.getTime() - todayOnly.getTime() > 0;
};

const prepareId = (url, type, id) => {
  const originalString = id;

  const parts = originalString.split("_");

  const year = parts[0];
  const month = parts[1];

  const lastTwoDigitsOfYear = year.substring(2);

  const transformedString = `${isItFuture(
    originalString,
  )}|${url}${month}_${lastTwoDigitsOfYear}/${originalString}_QHD.jpg|${type}|${originalString}| |${originalString}`;

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

  const transformedString = `${isItFuture2(
    date_open,
  )}|${url}${month}_${year}/${id}_QHD.jpg|${type}|${id}|${puzzle_start_price}|${date_open}`;

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
        prepareId2(imageUrl, type, currentObject.date_open, currentObject.puzzle_start_price, currentObject.id),
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

const fetchConfig2 = () => {
  function getTwoDigitsFromYear(n) {
    const numbers = [];
    for (let i = 26; i <= n; i++) {
      numbers.push(i);
    }
    return numbers;
  }

  const currentDate = new Date();
  const fullYear = currentDate.getFullYear();
  const lastTwoDigitsOfYear = fullYear % 100;

  const years = getTwoDigitsFromYear(lastTwoDigitsOfYear);
  const months = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
  const daysOfTheMonth = {
    "01": 31,
    "02": 29,
    "03": 31,
    "04": 30,
    "05": 31,
    "06": 30,
    "07": 31,
    "08": 31,
    "09": 30,
    10: 31,
    11: 30,
    12: 31,
  };

  const dates = years
    .map((year) => {
      return months.map((month) => {
        // console.log(`daysOfTheMonth[${month}]`, daysOfTheMonth[month]);

        return [`${year}_${month}`, daysOfTheMonth[month]];
      });
    })
    .flat();

  dates.unshift(["25_12", 31]);

  const urls_data = Object.fromEntries(
    dates.map(([key, maxNumber]) => [
      key,
      Array.from(
        { length: maxNumber },
        (_, i) =>
          `https://storage.googleapis.com/malpa-static/jigsaw_solitaire/daily_lvl/textures_levels/v1/${key}/${i + 1}.jpg`,
      ),
    ]),
  );

  return urls_data;
};

const fetchConfig = async () => {
  const urls = [];
  for (let i = 1; i <= 200; i++) {
    urls.push(
      `https://storage.googleapis.com/malpa-static/jigsaw_solitaire/chapters/config_chapters/v1/config_chapter_${i}.json`,
    );
  }

  const results = [];
  for (const url of urls) {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
      },
    });
    let data = {};

    if (!response.ok) {
      break;
    } else {
      data = await response.json();
    }

    results.push(data);
  }

  const chapters = results.map((chapter) => {
    const images = [
      {
        id: 0,
        title: `Глава ${chapter.chapter_id} Главная`,
        image_id: 0,
        image_url: `https://storage.googleapis.com/malpa-static/jigsaw_solitaire/chapters/textures_cards/v1/card_chapter_${chapter.chapter_id}.jpg`,
      },
    ];

    for (let i = 1; i <= 25; i++) {
      const complexity = chapter.levels[i - 1]?.complexity;
      const size = chapter.levels[i - 1]?.size;
      const type = chapter.levels[i - 1]?.type;
      const cards_sort = chapter.levels[i - 1]?.cards_sort?.join(",");
      images.push({
        id: chapter.chapter_id,
        title: `Глава ${chapter.chapter_id} Уровень ${i}`,
        image_id: i,
        complexity: complexity,
        size: size,
        type: type,
        cards_sort: cards_sort,
        image_url: `https://storage.googleapis.com/malpa-static/jigsaw_solitaire/chapters/textures_levels/v1/chapter_${chapter.chapter_id}/${i}.jpg`,
      });
    }

    return images;
  });

  return chapters;
};

const solitaireData = await fetchConfig();
const solitaireDailyData = await fetchConfig2();
const tagsData = await showTagsWithIdFor(
  "https://storage.googleapis.com/malpa-static/jigsawgram/daily_config/levels_chunk_",
  "daily",
  "https://storage.googleapis.com/malpa-static/jigsawgram/daily/",
);
const tagsData2 = await showTagsWithIdFor2(
  "https://storage.googleapis.com/malpa-static/jigsawgram/puzzles_config/levels_chunk_",
  "puzzle",
  "https://storage.googleapis.com/malpa-static/jigsawgram/puzzles/",
);

const finalData = mergeObjectsWithArrays(tagsData, tagsData2);

export default async function Home() {
  return (
    <div className="fixed top-[25px] left-[50px] w-[calc(100vw-100px)] h-[calc(100vh-70px)]">
      <MainPage finalData={finalData} solitaireData={solitaireData} solitaireDailyData={solitaireDailyData} />
    </div>
  );
}
