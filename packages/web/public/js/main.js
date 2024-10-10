const times = document.querySelectorAll("time");

for (const time of times) {
	const date = new Date(time.getAttribute("datetime") + "Z");
	time.textContent = date.toLocaleDateString({}, { hour: "2-digit", minute: "2-digit", hour12: false });
}
