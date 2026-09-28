const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const FEED_URL =
 "https://utility.arcgis.com/usrsvcs/servers/01c97e2928134efc93157d99f2d23047/rest/services/OpenData/Public_Safety/FeatureServer/0/query";
app.get("/api/incidents", async (req, res) => {
  try {
    const params = new URLSearchParams({
  where: "1=1",
  outFields: "ObjectID,InfoTitle,Call_Type,Address,Reported_Time",
  returnGeometry: "false",

  geometry: JSON.stringify({
    xmin: -10958012.374962993,
    ymin: 4226661.916058987,
    xmax: -10801469.341034994,
    ymax: 4383204.949986987
  }),

  geometryType: "esriGeometryEnvelope",
  inSR: "102100",
  spatialRel: "esriSpatialRelIntersects",
  
  f: "json"
});

    const url = `${FEED_URL}?${params.toString()}`;

    console.log("Requesting OKC feed:", url);

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`ArcGIS HTTP error: ${response.status}`);
    }

    const data = await response.json();

    // IMPORTANT: show us an ArcGIS error instead of pretending
    // there are simply zero incidents.
    if (data.error) {
      console.error("ArcGIS error:", data.error);

      return res.status(500).json({
        success: false,
        error: data.error
      });
    }

  let incidents = (data.features || []).map(feature => ({
  ...feature.attributes
}));

function getReportedTime(value) {
  if (!value) return 0;

  if (typeof value === "number") {
    return value;
  }

  // Convert "8:56AM" to "8:56 AM" for safer parsing
  const cleaned = String(value).replace(
    /(\d)(AM|PM)$/i,
    "$1 $2"
  );

  const time = Date.parse(cleaned);

  return Number.isNaN(time) ? 0 : time;
}

// Only show incidents reported within the last 24 hours
const cutoff = Date.now() - (24 * 60 * 60 * 1000);

incidents = incidents.filter(incident => {
  return getReportedTime(incident.Reported_Time) >= cutoff;
});

// Newest incidents first
incidents.sort((a, b) => {
  return getReportedTime(b.Reported_Time) -
         getReportedTime(a.Reported_Time);
});

    res.json({
      success: true,
      count: incidents.length,
      incidents
    });

  } catch (error) {
    console.error("Feed error:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "OKC Breaking News Monitor V2"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`OKC Breaking News Monitor running on port ${PORT}`);
});
